export type DiffLineType = 'context' | 'add' | 'remove' | 'hunk' | 'meta';

export interface WordSegment {
  text: string;
  changed: boolean;
}

export interface DiffLine {
  id: string;
  type: DiffLineType;
  text: string;
  oldNumber: number | null;
  newNumber: number | null;
  moved: boolean;
  noNewline?: boolean;
  segments?: WordSegment[];
}

export interface DiffRow {
  id: string;
  type: 'code' | 'hunk' | 'meta';
  oldLine?: DiffLine;
  newLine?: DiffLine;
  line?: DiffLine;
}

export interface ParsedDiff {
  lines: DiffLine[];
  rows: DiffRow[];
}

const tokenizeWords = (value: string) => value.split(/(\s+|[^\p{L}\p{N}_$]+)/u).filter(Boolean);

function mergeSegments(tokens: string[], changed: boolean[]): WordSegment[] {
  const segments: WordSegment[] = [];
  tokens.forEach((token, index) => {
    const previous = segments.at(-1);
    if (previous && previous.changed === changed[index]) previous.text += token;
    else segments.push({ text: token, changed: changed[index] ?? false });
  });
  return segments;
}

function wordChanges(before: string, after: string): [WordSegment[], WordSegment[]] {
  const oldTokens = tokenizeWords(before);
  const newTokens = tokenizeWords(after);

  if (oldTokens.length * newTokens.length > 12_000) {
    return [
      [{ text: before, changed: true }],
      [{ text: after, changed: true }]
    ];
  }

  const matrix = Array.from({ length: oldTokens.length + 1 }, () =>
    new Uint16Array(newTokens.length + 1)
  );

  for (let oldIndex = oldTokens.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newTokens.length - 1; newIndex >= 0; newIndex -= 1) {
      matrix[oldIndex][newIndex] =
        oldTokens[oldIndex] === newTokens[newIndex]
          ? (matrix[oldIndex + 1]?.[newIndex + 1] ?? 0) + 1
          : Math.max(matrix[oldIndex + 1]?.[newIndex] ?? 0, matrix[oldIndex]?.[newIndex + 1] ?? 0);
    }
  }

  const oldChanged = oldTokens.map(() => true);
  const newChanged = newTokens.map(() => true);
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < oldTokens.length && newIndex < newTokens.length) {
    if (oldTokens[oldIndex] === newTokens[newIndex]) {
      oldChanged[oldIndex] = false;
      newChanged[newIndex] = false;
      oldIndex += 1;
      newIndex += 1;
    } else if ((matrix[oldIndex + 1]?.[newIndex] ?? 0) >= (matrix[oldIndex]?.[newIndex + 1] ?? 0)) {
      oldIndex += 1;
    } else {
      newIndex += 1;
    }
  }

  return [mergeSegments(oldTokens, oldChanged), mergeSegments(newTokens, newChanged)];
}

function markMovedLines(lines: DiffLine[]) {
  const removed = new Set(
    lines
      .filter((line) => line.type === 'remove' && line.text.trim().length > 3)
      .map((line) => line.text.trim())
  );
  const added = new Set(
    lines
      .filter((line) => line.type === 'add' && line.text.trim().length > 3)
      .map((line) => line.text.trim())
  );

  return lines.map((line) => ({
    ...line,
    moved:
      (line.type === 'add' || line.type === 'remove') &&
      removed.has(line.text.trim()) &&
      added.has(line.text.trim())
  }));
}

function pairRows(lines: DiffLine[]): DiffRow[] {
  const rows: DiffRow[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (line.type === 'hunk' || line.type === 'meta') {
      rows.push({ id: line.id, type: line.type, line });
      continue;
    }

    if (line.type === 'context') {
      rows.push({ id: line.id, type: 'code', oldLine: line, newLine: line });
      continue;
    }

    if (line.type === 'remove') {
      const removed: DiffLine[] = [];
      const added: DiffLine[] = [];
      while (lines[index]?.type === 'remove') {
        removed.push(lines[index]);
        index += 1;
      }
      while (lines[index]?.type === 'add') {
        added.push(lines[index]);
        index += 1;
      }
      index -= 1;

      const rowCount = Math.max(removed.length, added.length);
      for (let pairIndex = 0; pairIndex < rowCount; pairIndex += 1) {
        const oldLine = removed[pairIndex];
        const newLine = added[pairIndex];
        if (oldLine && newLine && !oldLine.moved && !newLine.moved) {
          const [oldSegments, newSegments] = wordChanges(oldLine.text, newLine.text);
          oldLine.segments = oldSegments;
          newLine.segments = newSegments;
        }
        rows.push({
          id: `pair-${oldLine?.id ?? 'empty'}-${newLine?.id ?? 'empty'}`,
          type: 'code',
          oldLine,
          newLine
        });
      }
      continue;
    }

    rows.push({ id: line.id, type: 'code', newLine: line });
  }

  return rows;
}

export function parseDiff(diff: string): ParsedDiff {
  let oldNumber = 0;
  let newNumber = 0;
  let inHunk = false;
  const parsed: DiffLine[] = [];

  const rawLines = diff.split('\n');
  rawLines.forEach((rawLine, index) => {
    if (rawLine === '' && index === rawLines.length - 1) return;
    if (rawLine === '\\ No newline at end of file') {
      const previous = parsed.at(-1);
      if (previous && previous.type !== 'hunk' && previous.type !== 'meta') previous.noNewline = true;
      return;
    }
    const hunk = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunk) {
      inHunk = true;
      oldNumber = Number(hunk[1]);
      newNumber = Number(hunk[2]);
      parsed.push({
        id: `hunk-${oldNumber}-${newNumber}`,
        type: 'hunk',
        text: rawLine,
        oldNumber: null,
        newNumber: null,
        moved: false
      });
      return;
    }

    if (rawLine.startsWith('diff --git')) {
      inHunk = false;
      return;
    }
    if (
      !inHunk &&
      (rawLine.startsWith('index ') || rawLine.startsWith('--- ') || rawLine.startsWith('+++ '))
    ) {
      return;
    }

    if (!inHunk) {
      parsed.push({
        id: `meta-${index}`,
        type: 'meta',
        text: rawLine,
        oldNumber: null,
        newNumber: null,
        moved: false
      });
      return;
    }

    if (rawLine.startsWith('-')) {
      parsed.push({
        id: `old-${oldNumber}`,
        type: 'remove',
        text: rawLine.slice(1),
        oldNumber,
        newNumber: null,
        moved: false
      });
      oldNumber += 1;
      return;
    }

    if (rawLine.startsWith('+')) {
      parsed.push({
        id: `new-${newNumber}`,
        type: 'add',
        text: rawLine.slice(1),
        oldNumber: null,
        newNumber,
        moved: false
      });
      newNumber += 1;
      return;
    }

    if (!rawLine.startsWith(' ')) {
      parsed.push({
        id: `meta-${index}`,
        type: 'meta',
        text: rawLine,
        oldNumber: null,
        newNumber: null,
        moved: false
      });
      return;
    }
    const text = rawLine.slice(1);
    parsed.push({
      id: `both-${oldNumber}-${newNumber}`,
      type: 'context',
      text,
      oldNumber,
      newNumber,
      moved: false
    });
    oldNumber += 1;
    newNumber += 1;
  });

  const lines = markMovedLines(parsed);
  return { lines, rows: pairRows(lines) };
}
