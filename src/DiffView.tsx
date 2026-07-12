import {
  Fragment,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { DiffResponse, ReviewComment } from "../shared/review-contract.js";
import {
  parseDiff,
  type DiffLine,
  type DiffRow,
  type WordSegment,
} from "./diff-model.js";
import { highlightLines, type SyntaxToken } from "./highlight.js";

const DESKTOP_ROW_HEIGHT = 26;
const TOUCH_ROW_HEIGHT = 34;
const HUNK_HEIGHT = 28;
const META_HEIGHT = 24;
const SPLIT_MIN_WIDTH = 800;
const OVERSCAN_ROWS = 24;

export interface SelectedLine {
  id: string;
  number: number | null;
  side: "old" | "new";
  label: string;
}

export interface DiffSearchStatus {
  current: number;
  total: number;
}

export interface DiffViewHandle {
  navigateSearch: (direction: 1 | -1) => void;
  navigateFocusedLine: (
    direction: 1 | -1,
    extend: boolean,
    count?: number,
  ) => void;
  navigateFocusedPage: (
    direction: 1 | -1,
    fraction: 0.5 | 1,
    extend: boolean,
  ) => void;
  focusBoundary: (boundary: "start" | "end", extend: boolean) => boolean;
  selectFocusedLine: () => boolean;
  focusCurrentLine: () => boolean;
  goToLine: (lineNumber: number) => boolean;
}

interface DiffViewProps {
  diff: DiffResponse;
  view: "adaptive" | "unified";
  search: string;
  selectedLines: SelectedLine[];
  onSelectionChange: (lines: SelectedLine[]) => void;
  onExpandContext: () => void;
  onSearchStatusChange: (status: DiffSearchStatus) => void;
  canExpandContext: boolean;
  vimMode: boolean;
}

type ActiveItem =
  | { id: string; type: "unified"; line: DiffLine }
  | { id: string; type: "split"; row: DiffRow };

function styledText(
  content: string,
  style: CSSProperties | undefined,
  key: string,
): ReactNode {
  return style ? (
    <span key={key} style={style}>
      {content}
    </span>
  ) : (
    content
  );
}

function renderCode(
  segments: WordSegment[] | undefined,
  text: string,
  syntax: SyntaxToken[] | undefined,
) {
  if (!syntax) {
    if (!segments) return text;
    return segments.map((segment, index) =>
      segment.changed ? (
        <mark className="word-change" key={`${segment.text}-${index}`}>
          {segment.text}
        </mark>
      ) : (
        <Fragment key={`${segment.text}-${index}`}>{segment.text}</Fragment>
      ),
    );
  }

  if (!segments) {
    return syntax.map((token, index) =>
      styledText(token.content, token.style, `syntax-${index}`),
    );
  }

  const output: ReactNode[] = [];
  let segmentIndex = 0;
  let segmentOffset = 0;

  syntax.forEach((token, tokenIndex) => {
    let tokenOffset = 0;
    while (
      tokenOffset < token.content.length &&
      segmentIndex < segments.length
    ) {
      const segment = segments[segmentIndex];
      if (!segment) break;
      const remainingToken = token.content.length - tokenOffset;
      const remainingSegment = segment.text.length - segmentOffset;
      const length = Math.min(remainingToken, remainingSegment);
      const content = token.content.slice(tokenOffset, tokenOffset + length);
      const key = `${tokenIndex}-${tokenOffset}`;
      const node = styledText(content, token.style, `${key}-text`);
      output.push(
        segment.changed ? (
          <mark className="word-change" key={key}>
            {node}
          </mark>
        ) : (
          <Fragment key={key}>{node}</Fragment>
        ),
      );
      tokenOffset += length;
      segmentOffset += length;
      if (segmentOffset >= segment.text.length) {
        segmentIndex += 1;
        segmentOffset = 0;
      }
    }
  });

  return output.length > 0 ? output : text;
}

function commentCount(
  comments: ReviewComment[],
  line: DiffLine,
  side: "old" | "new",
) {
  const lineNumber = side === "old" ? line.oldNumber : line.newNumber;
  return comments.filter((comment) => {
    return (
      !comment.outdated &&
      lineNumber !== null &&
      comment.anchors.some(
        (anchor) =>
          anchor.side === side &&
          lineNumber >= anchor.startLine &&
          lineNumber <= anchor.endLine,
      )
    );
  }).length;
}

function selectedLineFrom(
  line: DiffLine,
  preferredSide?: "old" | "new",
): SelectedLine {
  const side = preferredSide ?? (line.type === "remove" ? "old" : "new");
  const number = side === "old" ? line.oldNumber : line.newNumber;
  const resolvedNumber = number ?? line.newNumber ?? line.oldNumber;
  return {
    id: line.id,
    number: resolvedNumber,
    side,
    label:
      `${side === "old" ? "Old" : "New"} line ${resolvedNumber ?? ""}`.trim(),
  };
}

function changeLabel(line: DiffLine) {
  if (line.type === "add") return `Added line ${line.newNumber ?? ""}`.trim();
  if (line.type === "remove")
    return `Removed line ${line.oldNumber ?? ""}`.trim();
  return `Unchanged line ${line.newNumber ?? line.oldNumber ?? ""}`.trim();
}

function LineNumberButton({
  line,
  side,
  comments,
  selected,
  tabIndex,
  onFocusLine,
  onMoveFocus,
  onSelectLine,
}: {
  line: DiffLine;
  side: "old" | "new";
  comments: ReviewComment[];
  selected: boolean;
  tabIndex: number;
  onFocusLine: (lineId: string) => void;
  onMoveFocus: (lineId: string, direction: 1 | -1, extend: boolean) => void;
  onSelectLine: (
    line: SelectedLine,
    event: MouseEvent<HTMLButtonElement>,
  ) => void;
}) {
  const number = side === "old" ? line.oldNumber : line.newNumber;
  const count = commentCount(comments, line, side);
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      onMoveFocus(line.id, event.key === "ArrowDown" ? 1 : -1, event.shiftKey);
    }
  };

  return (
    <button
      aria-label={`Comment on ${side} line ${number ?? "unknown"}`}
      aria-pressed={selected}
      className="line-number-button"
      data-line-id={line.id}
      onClick={(event) => onSelectLine(selectedLineFrom(line, side), event)}
      onFocus={() => onFocusLine(line.id)}
      onKeyDown={handleKeyDown}
      tabIndex={tabIndex}
      type="button"
    >
      {number ?? ""}
      {count > 0 ? <span className="line-comment-count">{count}</span> : null}
    </button>
  );
}

function CodeContent({
  line,
  syntax,
}: {
  line: DiffLine;
  syntax?: SyntaxToken[];
}) {
  return (
    <code>
      <span className="visually-hidden">{changeLabel(line)}: </span>
      <span aria-hidden="true" className="change-symbol">
        {line.type === "add" ? "+" : line.type === "remove" ? "−" : " "}
      </span>
      <span>{renderCode(line.segments, line.text, syntax)}</span>
      {line.moved ? <span className="moved-label">moved</span> : null}
      {line.noNewline ? (
        <span className="no-newline-label">no newline</span>
      ) : null}
    </code>
  );
}

interface LineInteractionProps {
  diff: DiffResponse;
  focusedLineId: string;
  onFocusLine: (lineId: string) => void;
  onMoveFocus: (lineId: string, direction: 1 | -1, extend: boolean) => void;
  onSelectLine: (
    line: SelectedLine,
    event: MouseEvent<HTMLButtonElement>,
  ) => void;
  selectedIds: Set<string>;
}

function UnifiedLine({
  line,
  interaction,
  search,
  searchCurrent,
  syntax,
}: {
  line: DiffLine;
  interaction: LineInteractionProps;
  search: string;
  searchCurrent: boolean;
  syntax?: SyntaxToken[];
}) {
  const searchHit = Boolean(
    search && line.text.toLowerCase().includes(search.toLowerCase()),
  );

  if (line.type === "meta")
    return <div className="diff-meta-line">{line.text}</div>;

  return (
    <div
      aria-label={changeLabel(line)}
      className="unified-line"
      data-vim-focused={interaction.focusedLineId === line.id}
      data-line-type={line.type}
      data-search-current={searchCurrent && searchHit}
      data-search-hit={searchHit}
      data-selected={interaction.selectedIds.has(line.id)}
      role="group"
    >
      <span aria-hidden="true" className="unified-old-number">
        {line.oldNumber ?? ""}
      </span>
      <span className="unified-new-number">
        <LineNumberButton
          comments={interaction.diff.comments}
          line={line}
          onFocusLine={interaction.onFocusLine}
          onMoveFocus={interaction.onMoveFocus}
          onSelectLine={interaction.onSelectLine}
          selected={interaction.selectedIds.has(line.id)}
          side={line.type === "remove" ? "old" : "new"}
          tabIndex={interaction.focusedLineId === line.id ? 0 : -1}
        />
      </span>
      <CodeContent line={line} syntax={syntax} />
    </div>
  );
}

function SideCell({
  line,
  side,
  interaction,
  search,
  searchCurrent,
  syntax,
}: {
  line?: DiffLine;
  side: "old" | "new";
  interaction: LineInteractionProps;
  search: string;
  searchCurrent: boolean;
  syntax?: SyntaxToken[];
}) {
  if (!line)
    return <div aria-hidden="true" className="side-cell side-cell-empty" />;
  const searchHit = Boolean(
    search &&
    line.text.toLowerCase().includes(search.toLowerCase()) &&
    !(line.type === "context" && side === "old"),
  );
  const interactive = side === "new" || line.type === "remove";
  const number = side === "old" ? line.oldNumber : line.newNumber;

  return (
    <div
      aria-label={`${side === "old" ? "Before" : "After"}, ${changeLabel(line)}`}
      className="side-cell"
      data-vim-focused={interaction.focusedLineId === line.id}
      data-line-type={line.type}
      data-search-current={searchCurrent && searchHit}
      data-search-hit={searchHit}
      data-selected={interaction.selectedIds.has(line.id)}
      role="group"
    >
      {interactive ? (
        <LineNumberButton
          comments={interaction.diff.comments}
          line={line}
          onFocusLine={interaction.onFocusLine}
          onMoveFocus={interaction.onMoveFocus}
          onSelectLine={interaction.onSelectLine}
          selected={interaction.selectedIds.has(line.id)}
          side={side}
          tabIndex={interaction.focusedLineId === line.id ? 0 : -1}
        />
      ) : (
        <span aria-hidden="true" className="side-line-number">
          {number ?? ""}
        </span>
      )}
      <CodeContent line={line} syntax={syntax} />
    </div>
  );
}

function HunkLine({
  text,
  onExpandContext,
  canExpandContext,
}: {
  text: string;
  onExpandContext: () => void;
  canExpandContext: boolean;
}) {
  return (
    <div className="diff-hunk-line" role="separator">
      <span>{text}</span>
      {canExpandContext ? (
        <button onClick={onExpandContext} type="button">
          Show more context
        </button>
      ) : null}
    </div>
  );
}

function itemHeight(
  item: ActiveItem,
  rowHeight: number,
  hunkHeight: number,
  metaHeight: number,
) {
  const type = item.type === "unified" ? item.line.type : item.row.type;
  if (type === "hunk") return hunkHeight;
  if (type === "meta") return metaHeight;
  return rowHeight;
}

function itemText(item: ActiveItem) {
  if (item.type === "unified") return item.line.text;
  if (item.row.line) return item.row.line.text;
  return `${item.row.oldLine?.text ?? ""}\n${item.row.newLine?.text ?? ""}`;
}

function itemLines(item: ActiveItem) {
  if (item.type === "unified") return [item.line];
  return [item.row.oldLine, item.row.newLine].filter((line): line is DiffLine =>
    Boolean(line),
  );
}

function findItemIndexForLine(items: ActiveItem[], lineId: string) {
  return items.findIndex((item) =>
    itemLines(item).some((line) => line.id === lineId),
  );
}

function useVirtualWindow(
  bodyRef: RefObject<HTMLDivElement | null>,
  heights: number[],
  scrolloffRows: number,
) {
  const offsets = useMemo(() => {
    const values = new Array<number>(heights.length + 1).fill(0);
    heights.forEach((height, index) => {
      values[index + 1] = (values[index] ?? 0) + height;
    });
    return values;
  }, [heights]);
  const [windowState, setWindowState] = useState({
    start: 0,
    end: Math.min(80, heights.length),
  });
  const scrollerRef = useRef<HTMLElement | null>(null);

  const updateWindow = useCallback(() => {
    const body = bodyRef.current;
    const scroller = scrollerRef.current;
    if (!body || !scroller) return;
    const bodyTop =
      body.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop;
    const visibleTop = Math.max(0, scroller.scrollTop - bodyTop);
    const visibleBottom = visibleTop + scroller.clientHeight;
    const first = Math.max(
      0,
      offsets.findIndex(
        (offset, index) =>
          index < heights.length &&
          (offsets[index + 1] ?? offset) >= visibleTop,
      ),
    );
    let last = first;
    while (last < heights.length && (offsets[last] ?? 0) <= visibleBottom)
      last += 1;
    setWindowState({
      start: Math.max(0, first - OVERSCAN_ROWS),
      end: Math.min(heights.length, last + OVERSCAN_ROWS),
    });
  }, [bodyRef, heights.length, offsets]);

  useEffect(() => {
    const body = bodyRef.current;
    const scroller = body?.closest(".diff-scroll") as HTMLElement | null;
    if (!body || !scroller) return;
    scrollerRef.current = scroller;
    const observer = new ResizeObserver(updateWindow);
    observer.observe(scroller);
    scroller.addEventListener("scroll", updateWindow, { passive: true });
    updateWindow();
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", updateWindow);
      scrollerRef.current = null;
    };
  }, [bodyRef, updateWindow]);

  const scrollToIndex = useCallback(
    (index: number) => {
      const body = bodyRef.current;
      const scroller = scrollerRef.current;
      if (!body || !scroller || index < 0 || index >= heights.length) return;
      const bodyTop =
        body.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop;
      const top = bodyTop + (offsets[index] ?? 0);
      const bottom = top + (heights[index] ?? 0);
      const viewportTop = scroller.scrollTop;
      const viewportBottom = viewportTop + scroller.clientHeight;
      const marginStartIndex = Math.max(0, index - scrolloffRows);
      const marginEndIndex = Math.min(
        heights.length,
        index + scrolloffRows + 1,
      );
      const marginTop =
        (offsets[index] ?? 0) - (offsets[marginStartIndex] ?? 0);
      const marginBottom =
        (offsets[marginEndIndex] ?? bottom) - (offsets[index + 1] ?? bottom);
      if (top < viewportTop + marginTop) {
        scroller.scrollTo({
          top: Math.max(0, top - marginTop),
          behavior: "auto",
        });
      } else if (bottom > viewportBottom - marginBottom) {
        scroller.scrollTo({
          top: Math.max(0, bottom + marginBottom - scroller.clientHeight),
          behavior: "auto",
        });
      }
      window.requestAnimationFrame(updateWindow);
    },
    [bodyRef, heights, offsets, scrolloffRows, updateWindow],
  );

  return {
    ...windowState,
    offset: offsets[windowState.start] ?? 0,
    totalHeight: offsets.at(-1) ?? 0,
    scrollToIndex,
  };
}

export const DiffView = forwardRef<DiffViewHandle, DiffViewProps>(
  function DiffView(
    {
      diff,
      view,
      search,
      selectedLines,
      onSelectionChange,
      onExpandContext,
      onSearchStatusChange,
      canExpandContext,
      vimMode,
    },
    ref,
  ) {
    const parsed = useMemo(() => parseDiff(diff.diff), [diff.diff]);
    const rootRef = useRef<HTMLDivElement>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    const syntaxCacheRef = useRef<Map<string, SyntaxToken[]>>(new Map());
    const pendingFocusLineIdRef = useRef("");
    const [syntaxVersion, setSyntaxVersion] = useState(0);
    const [availableWidth, setAvailableWidth] = useState(0);
    const [coarsePointer, setCoarsePointer] = useState(false);
    const selectableLines = useMemo(
      () =>
        parsed.lines.filter(
          (line) =>
            line.type === "add" ||
            line.type === "remove" ||
            line.type === "context",
        ),
      [parsed.lines],
    );
    const defaultFocusedLineId =
      selectableLines.find((line) => line.type === "add")?.id ??
      selectableLines.find((line) => line.newNumber !== null)?.id ??
      selectableLines[0]?.id ??
      "";
    const [focusedLineId, setFocusedLineId] = useState(defaultFocusedLineId);
    const [activeMatch, setActiveMatch] = useState(0);
    const selectedIds = useMemo(
      () => new Set(selectedLines.map((line) => line.id)),
      [selectedLines],
    );
    const canUseSplitView =
      parsed.lines.some((line) => line.type === "add") &&
      parsed.lines.some((line) => line.type === "remove");
    const effectiveView =
      view === "adaptive" &&
      canUseSplitView &&
      availableWidth >= SPLIT_MIN_WIDTH
        ? "split"
        : "unified";
    const codeScale = Number.parseFloat(
      window
        .getComputedStyle(document.documentElement)
        .getPropertyValue("--typography-code-scale"),
    );
    const rowHeight = Math.round(
      (coarsePointer ? TOUCH_ROW_HEIGHT : DESKTOP_ROW_HEIGHT) *
        (Number.isFinite(codeScale) ? codeScale : 1),
    );
    const normalizedCodeScale = Number.isFinite(codeScale) ? codeScale : 1;
    const hunkHeight = Math.round(HUNK_HEIGHT * normalizedCodeScale);
    const metaHeight = Math.round(META_HEIGHT * normalizedCodeScale);
    const items = useMemo<ActiveItem[]>(
      () =>
        effectiveView === "split"
          ? parsed.rows.map((row) => ({ id: row.id, type: "split", row }))
          : parsed.lines.map((line) => ({
              id: line.id,
              type: "unified",
              line,
            })),
      [effectiveView, parsed.lines, parsed.rows],
    );
    const heights = useMemo(
      () =>
        items.map((item) =>
          itemHeight(item, rowHeight, hunkHeight, metaHeight),
        ),
      [hunkHeight, items, metaHeight, rowHeight],
    );
    const {
      start: virtualStart,
      end: virtualEnd,
      offset: virtualOffset,
      totalHeight,
      scrollToIndex,
    } = useVirtualWindow(bodyRef, heights, vimMode ? 6 : 0);
    const visibleItems = items.slice(virtualStart, virtualEnd);
    const normalizedSearch = search.trim().toLowerCase();
    const matchIndexes = useMemo(
      () =>
        normalizedSearch
          ? items.flatMap((item, index) =>
              itemText(item).toLowerCase().includes(normalizedSearch)
                ? [index]
                : [],
            )
          : [],
      [items, normalizedSearch],
    );
    const firstMatchIndex = matchIndexes[0];

    useEffect(() => {
      const root = rootRef.current;
      const scroller = root?.closest(".diff-scroll");
      if (!root || !scroller) return;
      const updateWidth = () => setAvailableWidth(scroller.clientWidth);
      const observer = new ResizeObserver(updateWidth);
      observer.observe(scroller);
      updateWidth();
      return () => observer.disconnect();
    }, []);

    useEffect(() => {
      const media = window.matchMedia("(pointer: coarse)");
      const updatePointer = () => setCoarsePointer(media.matches);
      media.addEventListener("change", updatePointer);
      updatePointer();
      return () => media.removeEventListener("change", updatePointer);
    }, []);

    useEffect(() => {
      syntaxCacheRef.current = new Map();
      setSyntaxVersion((current) => current + 1);
    }, [diff.fingerprint, diff.language]);

    const visibleCodeLines = useMemo(() => {
      const lines = visibleItems
        .flatMap(itemLines)
        .filter(
          (line) =>
            line.type === "add" ||
            line.type === "remove" ||
            line.type === "context",
        );
      return [...new Map(lines.map((line) => [line.id, line])).values()];
    }, [visibleItems]);

    const visibleSelectableLines = useMemo(() => {
      const lines = visibleItems
        .flatMap(itemLines)
        .filter(
          (line) =>
            line.type === "add" ||
            line.type === "remove" ||
            line.type === "context",
        );
      return [...new Map(lines.map((line) => [line.id, line])).values()];
    }, [visibleItems]);

    useEffect(() => {
      if (
        visibleSelectableLines.length > 0 &&
        !visibleSelectableLines.some((line) => line.id === focusedLineId)
      ) {
        setFocusedLineId(visibleSelectableLines[0]?.id ?? "");
      }
    }, [focusedLineId, visibleSelectableLines]);

    useEffect(() => {
      let cancelled = false;
      const missing = visibleCodeLines.filter(
        (line) => !syntaxCacheRef.current.has(line.id),
      );
      if (missing.length === 0) return;
      void highlightLines(
        missing.map((line) => line.text),
        diff.language,
      )
        .then((highlighted) => {
          if (cancelled) return;
          missing.forEach((line, index) =>
            syntaxCacheRef.current.set(line.id, highlighted[index] ?? []),
          );
          setSyntaxVersion((current) => current + 1);
        })
        .catch(() => undefined);
      return () => {
        cancelled = true;
      };
    }, [diff.language, visibleCodeLines]);

    useEffect(() => {
      setFocusedLineId((current) =>
        selectableLines.some((line) => line.id === current)
          ? current
          : defaultFocusedLineId,
      );
    }, [defaultFocusedLineId, selectableLines]);

    useEffect(() => {
      setFocusedLineId(defaultFocusedLineId);
    }, [defaultFocusedLineId, diff.fingerprint]);

    useEffect(() => {
      setActiveMatch(0);
      if (firstMatchIndex !== undefined) {
        window.requestAnimationFrame(() => scrollToIndex(firstMatchIndex));
      }
    }, [effectiveView, firstMatchIndex, normalizedSearch, scrollToIndex]);

    useEffect(() => {
      onSearchStatusChange({
        current:
          matchIndexes.length > 0
            ? Math.min(activeMatch + 1, matchIndexes.length)
            : 0,
        total: matchIndexes.length,
      });
    }, [activeMatch, matchIndexes.length, onSearchStatusChange]);

    const focusLine = useCallback(
      (line: DiffLine | undefined) => {
        if (!line) return false;
        pendingFocusLineIdRef.current = line.id;
        setFocusedLineId(line.id);
        const itemIndex = findItemIndexForLine(items, line.id);
        scrollToIndex(itemIndex);
        const button = rootRef.current?.querySelector<HTMLButtonElement>(
          `[data-line-id="${CSS.escape(line.id)}"]`,
        );
        if (button) {
          button.focus();
          pendingFocusLineIdRef.current = "";
        }
        return true;
      },
      [items, scrollToIndex],
    );

    useEffect(() => {
      const lineId = pendingFocusLineIdRef.current;
      if (!lineId) return;
      const button = rootRef.current?.querySelector<HTMLButtonElement>(
        `[data-line-id="${CSS.escape(lineId)}"]`,
      );
      if (!button) return;
      button.focus();
      pendingFocusLineIdRef.current = "";
    }, [focusedLineId, virtualEnd, virtualStart]);

    const navigateSearch = useCallback(
      (direction: 1 | -1) => {
        if (matchIndexes.length === 0) return;
        setActiveMatch((current) => {
          const next =
            (current + direction + matchIndexes.length) % matchIndexes.length;
          scrollToIndex(matchIndexes[next] ?? 0);
          return next;
        });
      },
      [matchIndexes, scrollToIndex],
    );

    const selectFocusedLine = useCallback(() => {
      const focusedLine =
        selectableLines.find((line) => line.id === focusedLineId) ??
        selectableLines[0];
      if (!focusedLine) return false;
      onSelectionChange([selectedLineFrom(focusedLine)]);
      return true;
    }, [focusedLineId, onSelectionChange, selectableLines]);

    const focusCurrentLine = useCallback(() => {
      const matchItem =
        normalizedSearch && matchIndexes.length > 0
          ? items[
              matchIndexes[Math.min(activeMatch, matchIndexes.length - 1)] ?? -1
            ]
          : undefined;
      const matchLines = matchItem
        ? itemLines(matchItem).filter(
            (line) =>
              line.type === "add" ||
              line.type === "remove" ||
              line.type === "context",
          )
        : [];
      const matchedLine =
        matchLines.find((line) =>
          line.text.toLowerCase().includes(normalizedSearch),
        ) ?? matchLines[0];
      const focusedLine =
        selectableLines.find((line) => line.id === focusedLineId) ??
        selectableLines[0];
      return focusLine(matchedLine ?? focusedLine);
    }, [
      activeMatch,
      focusLine,
      focusedLineId,
      items,
      matchIndexes,
      normalizedSearch,
      selectableLines,
    ]);

    const goToLine = useCallback(
      (lineNumber: number) => {
        const line =
          selectableLines.find(
            (candidate) => candidate.newNumber === lineNumber,
          ) ??
          selectableLines.find(
            (candidate) => candidate.oldNumber === lineNumber,
          );
        return focusLine(line);
      },
      [focusLine, selectableLines],
    );

    const selectRange = useCallback(
      (anchorId: string, targetId: string) => {
        const anchorIndex = selectableLines.findIndex(
          (candidate) => candidate.id === anchorId,
        );
        const targetIndex = selectableLines.findIndex(
          (candidate) => candidate.id === targetId,
        );
        if (anchorIndex < 0 || targetIndex < 0) return false;
        const start = Math.min(anchorIndex, targetIndex);
        const end = Math.max(anchorIndex, targetIndex);
        onSelectionChange(
          selectableLines
            .slice(start, end + 1)
            .map((line) => selectedLineFrom(line)),
        );
        return true;
      },
      [onSelectionChange, selectableLines],
    );

    const selectLine = useCallback(
      (line: SelectedLine, event: MouseEvent<HTMLButtonElement>) => {
        if (event.shiftKey && selectedLines.length > 0) {
          const anchorId = selectedLines.at(-1)?.id;
          if (anchorId && selectRange(anchorId, line.id)) return;
        }

        if (event.ctrlKey || event.metaKey) {
          onSelectionChange(
            selectedIds.has(line.id)
              ? selectedLines.filter((selected) => selected.id !== line.id)
              : [...selectedLines, line],
          );
          return;
        }

        onSelectionChange([line]);
      },
      [onSelectionChange, selectRange, selectedIds, selectedLines],
    );

    const moveLineFocus = useCallback(
      (lineId: string, direction: 1 | -1, extend: boolean) => {
        const currentIndex = selectableLines.findIndex(
          (line) => line.id === lineId,
        );
        if (currentIndex < 0) return;
        const nextIndex = Math.min(
          Math.max(currentIndex + direction, 0),
          selectableLines.length - 1,
        );
        const nextLine = selectableLines[nextIndex];
        if (!nextLine) return;
        if (extend) {
          const anchor = selectedLines[0]?.id ?? lineId;
          selectRange(anchor, nextLine.id);
        }
        focusLine(nextLine);
      },
      [focusLine, selectRange, selectableLines, selectedLines],
    );

    const navigateFocusedLine = useCallback(
      (direction: 1 | -1, extend: boolean, count = 1) => {
        const currentIndex = Math.max(
          0,
          selectableLines.findIndex((line) => line.id === focusedLineId),
        );
        const nextIndex = Math.min(
          Math.max(currentIndex + direction * Math.max(1, count), 0),
          selectableLines.length - 1,
        );
        const nextLine = selectableLines[nextIndex];
        if (!nextLine) return;
        if (extend) {
          const anchor =
            selectedLines[0]?.id ?? selectableLines[currentIndex]?.id;
          if (anchor) selectRange(anchor, nextLine.id);
        }
        focusLine(nextLine);
      },
      [focusLine, focusedLineId, selectRange, selectableLines, selectedLines],
    );

    const navigateFocusedPage = useCallback(
      (direction: 1 | -1, fraction: 0.5 | 1, extend: boolean) => {
        const scroller = rootRef.current?.closest(".diff-scroll");
        const visibleRows = Math.max(
          1,
          Math.floor((scroller?.clientHeight ?? rowHeight) / rowHeight),
        );
        navigateFocusedLine(
          direction,
          extend,
          Math.max(1, Math.floor(visibleRows * fraction)),
        );
      },
      [navigateFocusedLine, rowHeight],
    );

    const focusBoundary = useCallback(
      (boundary: "start" | "end", extend: boolean) => {
        const target =
          boundary === "start" ? selectableLines[0] : selectableLines.at(-1);
        if (!target) return false;
        if (extend) {
          const anchor = selectedLines[0]?.id ?? focusedLineId;
          selectRange(anchor, target.id);
        }
        return focusLine(target);
      },
      [focusLine, focusedLineId, selectRange, selectableLines, selectedLines],
    );

    useImperativeHandle(
      ref,
      () => ({
        navigateSearch,
        navigateFocusedLine,
        navigateFocusedPage,
        focusBoundary,
        selectFocusedLine,
        focusCurrentLine,
        goToLine,
      }),
      [
        focusBoundary,
        focusCurrentLine,
        goToLine,
        navigateFocusedLine,
        navigateFocusedPage,
        navigateSearch,
        selectFocusedLine,
      ],
    );

    const interaction = useMemo<LineInteractionProps>(
      () => ({
        diff,
        focusedLineId,
        onFocusLine: setFocusedLineId,
        onMoveFocus: moveLineFocus,
        onSelectLine: selectLine,
        selectedIds,
      }),
      [diff, focusedLineId, moveLineFocus, selectLine, selectedIds],
    );

    if (!diff.diff.trim()) {
      return (
        <div className="diff-empty">
          <p>No text changes to display.</p>
          <span>This may be a mode-only or metadata change.</span>
        </div>
      );
    }

    return (
      <div
        className="diff-view"
        data-effective-view={effectiveView}
        data-vim-mode={vimMode}
        data-view={view}
        ref={rootRef}
        style={
          {
            "--diff-row-height": `${rowHeight}px`,
            "--diff-hunk-height": `${hunkHeight}px`,
            "--diff-meta-height": `${metaHeight}px`,
          } as CSSProperties
        }
      >
        <div
          aria-keyshortcuts="c g"
          aria-label={
            effectiveView === "split" ? "Side by side diff" : "Unified diff"
          }
          className={effectiveView === "split" ? "split-diff" : "unified-diff"}
          role="region"
        >
          {effectiveView === "split" ? (
            <div className="split-heading">
              <span>Before</span>
              <span>After</span>
            </div>
          ) : null}
          <div
            className="virtual-diff-body"
            ref={bodyRef}
            style={{ height: totalHeight }}
          >
            <div
              className="virtual-diff-window"
              style={{ transform: `translateY(${virtualOffset}px)` }}
            >
              {visibleItems.map((item, visibleIndex) => {
                const itemIndex = virtualStart + visibleIndex;
                const searchCurrent = matchIndexes[activeMatch] === itemIndex;
                if (item.type === "unified") {
                  return item.line.type === "hunk" ? (
                    <HunkLine
                      canExpandContext={canExpandContext}
                      key={item.id}
                      onExpandContext={onExpandContext}
                      text={item.line.text}
                    />
                  ) : (
                    <UnifiedLine
                      interaction={interaction}
                      key={item.id}
                      line={item.line}
                      search={normalizedSearch}
                      searchCurrent={searchCurrent}
                      syntax={syntaxCacheRef.current.get(item.line.id)}
                    />
                  );
                }

                const row = item.row;
                if (row.type === "hunk" && row.line) {
                  return (
                    <HunkLine
                      canExpandContext={canExpandContext}
                      key={item.id}
                      onExpandContext={onExpandContext}
                      text={row.line.text}
                    />
                  );
                }
                if (row.type === "meta" && row.line) {
                  return (
                    <div className="diff-meta-line" key={item.id}>
                      {row.line.text}
                    </div>
                  );
                }
                return (
                  <div className="split-row" key={item.id}>
                    <SideCell
                      interaction={interaction}
                      line={row.oldLine}
                      search={normalizedSearch}
                      searchCurrent={searchCurrent}
                      side="old"
                      syntax={
                        row.oldLine
                          ? syntaxCacheRef.current.get(row.oldLine.id)
                          : undefined
                      }
                    />
                    <SideCell
                      interaction={interaction}
                      line={row.newLine}
                      search={normalizedSearch}
                      searchCurrent={searchCurrent}
                      side="new"
                      syntax={
                        row.newLine
                          ? syntaxCacheRef.current.get(row.newLine.id)
                          : undefined
                      }
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <span className="visually-hidden" data-syntax-version={syntaxVersion} />
      </div>
    );
  },
);
