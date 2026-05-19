import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import Editor, { loader, type Monaco } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import {
  createDirectory,
  getWorkspaceRoot,
  isTauriRuntime,
  listEntries,
  pickDirectory,
  pickFile,
  readTextFile,
  runYalex,
  writeTextFile,
} from "./api";
import type { FileNode, OpenTab, YalexAction, YaparAction, AnyAction, YaparSpecResult, YaparAutomatonResult, YaparTableResult, YaparParseResult } from "./types";

loader.config({ monaco });

const saveIcon = "/icons/save.svg";
const filePlusIcon = "/icons/file-plus.svg";
const folderPlusIcon = "/icons/folder-plus.svg";

type OutputItem = {
  ts: string;
  type: "info" | "ok" | "error";
  text: string;
};

const YAL_ACTIONS: Array<{ id: YalexAction; label: string }> = [
  { id: "spec", label: "Spec (JSON)" },
  { id: "ast", label: "AST" },
  { id: "combinedNfa", label: "Construcción Directa" },
  { id: "dfa", label: "DFA" },
  { id: "tokenize", label: "Tokenizar" },
  { id: "generate", label: "Generar Lexer" },
];

const YAPAR_ACTIONS: Array<{ id: YaparAction; label: string }> = [
  { id: "yaparSpec", label: "Especificación" },
  { id: "yaparAutomaton", label: "Autómata LR(0)" },
  { id: "yaparTable", label: "Tabla SLR" },
  { id: "yaparParse", label: "Parsear" },
  { id: "yaparGenerate", label: "Generar Parser" },
];

const FULL_PIPELINE_ACTIONS: YalexAction[] = YAL_ACTIONS.map((action) => action.id);
const YAPAR_PIPELINE_ACTIONS: YaparAction[] = YAPAR_ACTIONS.map((action) => action.id);

function getActionLabel(action: AnyAction): string {
  const yalMatch = YAL_ACTIONS.find((item) => item.id === action);
  if (yalMatch) return yalMatch.label;
  const yaparMatch = YAPAR_ACTIONS.find((item) => item.id === action);
  if (yaparMatch) return yaparMatch.label;
  return action;
}

const PANEL_STORAGE_KEY = "yalex-studio.panel-sizes.v1";

type PanelSizes = {
  sidebarWidth: number;
  rightPanelWidth: number;
  resultPanelHeight: number;
  outputPanelHeight: number;
};

type GraphNode = {
  id: string;
  label: string;
  isStart?: boolean;
  isAccept?: boolean;
};

type GraphEdge = {
  from: string;
  to: string;
  label: string;
};

type GraphPanel = {
  title: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

type ValidationCheck = {
  id: YalexAction;
  label: string;
  ok: boolean;
  detail: string;
};

type DfaEdgeLabelMode = "ranges" | "aliases";
type DfaLabelDensity = "compact" | "detailed";

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function formatCharLabel(raw: string): string {
  if (raw === "\n") return "\\n";
  if (raw === "\r") return "\\r";
  if (raw === "\t") return "\\t";
  if (raw === " ") return "space";
  if (raw === "\\") return "\\\\";

  if (raw.length === 1) {
    const code = raw.charCodeAt(0);
    if (code < 32 || code === 127) {
      return `\\x${code.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }

  return raw;
}

function transitionLabel(transition: Record<string, unknown>): string {
  const char = asString(transition.char);
  if (char !== null) {
    return formatCharLabel(char);
  }

  const kind = asString(transition.kind) ?? "?";
  const payload = asObject(transition.payload);
  if (kind === "epsilon") return "ε";
  if (kind === "char") return payload?.value ? formatCharLabel(String(payload.value)) : "char";
  if (kind === "wildcard") return "wildcard";
  if (kind === "charset") return "charset";
  if (kind === "charset_difference") return "set-diff";
  return kind;
}

function escapeCharForSetLiteral(ch: string): string {
  if (ch === "\\") return "\\\\";
  if (ch === "'") return "\\'";
  if (ch === "\n") return "\\n";
  if (ch === "\r") return "\\r";
  if (ch === "\t") return "\\t";

  if (ch.length === 1) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code === 127) {
      return `\\x${code.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }

  return ch;
}

function buildCanonicalCodeSet(codes: number[]): string {
  return codes.join(",");
}

function getKnownAliasDefinitions(): Array<{ name: string; codes: number[] }> {
  const lower = Array.from({ length: 26 }, (_, i) => 97 + i);
  const upper = Array.from({ length: 26 }, (_, i) => 65 + i);
  const digits = Array.from({ length: 10 }, (_, i) => 48 + i);
  const vowels = [65, 69, 73, 79, 85, 97, 101, 105, 111, 117].sort((a, b) => a - b);
  const letter = [...upper, ...lower].sort((a, b) => a - b);
  const vowelSet = new Set(vowels);
  const consonant = letter.filter((code) => !vowelSet.has(code));
  const ws = [9, 10, 13, 32];

  return [
    { name: "consonant", codes: consonant },
    { name: "vowel", codes: vowels },
    { name: "letter", codes: letter },
    { name: "lower", codes: lower },
    { name: "upper", codes: upper },
    { name: "digit", codes: digits },
    { name: "ws", codes: ws },
  ];
}

function getAliasForCharCodes(codes: number[]): string | null {
  const unique = Array.from(new Set(codes)).sort((a, b) => a - b);
  const key = buildCanonicalCodeSet(unique);

  const aliasMap = new Map<string, string>(
    getKnownAliasDefinitions().map((entry) => [buildCanonicalCodeSet(entry.codes), entry.name])
  );

  return aliasMap.get(key) ?? null;
}

function factorAliasesFromCodes(codes: number[]): { aliases: string[]; remaining: number[] } {
  const remaining = new Set(codes);
  const aliases: string[] = [];

  const definitions = getKnownAliasDefinitions().sort((a, b) => b.codes.length - a.codes.length);
  for (const definition of definitions) {
    const allPresent = definition.codes.every((code) => remaining.has(code));
    if (!allPresent) {
      continue;
    }

    aliases.push(definition.name);
    for (const code of definition.codes) {
      remaining.delete(code);
    }
  }

  return {
    aliases,
    remaining: Array.from(remaining).sort((a, b) => a - b),
  };
}

function formatCharSetLabel(chars: string[], mode: DfaEdgeLabelMode = "ranges"): string {
  if (chars.length === 0) {
    return "";
  }

  const sortedCodes = Array.from(new Set(chars.map((ch) => ch.charCodeAt(0)))).sort((a, b) => a - b);

  const alias = getAliasForCharCodes(sortedCodes);
  if (mode === "aliases" && alias) {
    return alias;
  }

  if (mode === "aliases") {
    const factored = factorAliasesFromCodes(sortedCodes);
    if (factored.aliases.length > 0) {
      const parts: string[] = [factored.aliases.join(" ")];
      if (factored.remaining.length > 0) {
        parts.push(formatCharSetLabel(factored.remaining.map((code) => String.fromCharCode(code)), "ranges"));
      }
      return parts.join("\n");
    }
  }

  const ranges: Array<{ start: number; end: number }> = [];
  let start = sortedCodes[0];
  let end = sortedCodes[0];

  for (let i = 1; i < sortedCodes.length; i++) {
    const next = sortedCodes[i];
    if (next === end + 1) {
      end = next;
      continue;
    }
    ranges.push({ start, end });
    start = next;
    end = next;
  }
  ranges.push({ start, end });

  const labels = ranges.map((range) => {
    const startLit = escapeCharForSetLiteral(String.fromCharCode(range.start));
    const endLit = escapeCharForSetLiteral(String.fromCharCode(range.end));
    if (range.start === range.end) {
      return `['${startLit}']`;
    }
    return `['${startLit}'-'${endLit}']`;
  });

  const groupsPerLine = 4;
  const lines: string[] = [];
  for (let i = 0; i < labels.length; i += groupsPerLine) {
    lines.push(labels.slice(i, i + groupsPerLine).join(" "));
  }

  return lines.join("\n");
}

function renderEdgeLabel(
  label: string,
  x: number,
  y: number,
  className: string,
  textAnchor: "start" | "middle" | "end" = "middle"
): JSX.Element {
  const lines = label.split("\n");
  const maxChars = Math.max(...lines.map((line) => line.length), 1);
  // Use larger metrics only for YAPar transition labels
  const isYaparLabel = className.includes("yapar-transition-label") || className.includes("yapar-transition");
  const lineHeight = isYaparLabel ? 28 : 14;
  const charWidth = isYaparLabel ? 14 : 7;
  const boxWidth = Math.min(isYaparLabel ? 600 : 300, Math.max(isYaparLabel ? 56 : 44, maxChars * charWidth + (isYaparLabel ? 18 : 14)));
  const boxHeight = lines.length * lineHeight + (isYaparLabel ? 12 : 8);
  const boxX = x - boxWidth / 2;
  const boxY = y - boxHeight / 2;
  const textStartY = boxY + (isYaparLabel ? Math.round(lineHeight / 1.8) : 14);

  return (
    <g className="graph-edge-label-group">
      <rect x={boxX} y={boxY} width={boxWidth} height={boxHeight} rx={4} className="graph-edge-label-box" />
      <text x={x} y={textStartY} className={className} textAnchor={textAnchor}>
        {lines.map((line, index) => (
          <tspan key={`${line}-${index}`} x={x} dy={index === 0 ? "0" : `${lineHeight}px`}>
            {line}
          </tspan>
        ))}
      </text>
    </g>
  );
}

function buildSingleAutomatonPanel(
  source: unknown,
  title: string,
  includeDfaAcceptMetadata: boolean,
  dfaEdgeLabelMode: DfaEdgeLabelMode
): GraphPanel | null {
  const src = asObject(source);
  if (!src) return null;
  // keep legacy name used below
  const sourceObj: Record<string, unknown> = src;
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const stateSet = new Set<string>();

  const startState = asNumber(sourceObj.start_state);
  const acceptSingle = asNumber(sourceObj.accept_state);
  const acceptStatesMulti = new Set<number>();

  for (const acceptItem of asArray(sourceObj.accept_states)) {
    const acceptObj = asObject(acceptItem);
    if (!acceptObj) continue;
    const state = asNumber(acceptObj.state);
    if (state !== null) {
      acceptStatesMulti.add(state);
    }
  }

  for (const stateItem of asArray(sourceObj.states)) {
    const stateObj = asObject(stateItem);
    if (stateObj && includeDfaAcceptMetadata) {
      const sid = asNumber(stateObj.id);
      if (sid === null) continue;
      const isAccept = Boolean(stateObj.is_accept);
      const labelRaw = asString(stateObj.accept_label);
      const label = labelRaw ? `q${sid} (${labelRaw})` : `q${sid}`;
      stateSet.add(String(sid));
      nodes.push({
        id: String(sid),
        label,
        isStart: startState === sid,
        isAccept,
      });
      continue;
    }

    const sid = asNumber(stateItem);
    if (sid === null) continue;
    stateSet.add(String(sid));
    nodes.push({
      id: String(sid),
      label: `q${sid}`,
      isStart: startState === sid,
      isAccept: acceptSingle === sid || acceptStatesMulti.has(sid),
    });
  }

  const edgeBuckets = new Map<
    string,
    {
      from: string;
      to: string;
      chars: string[];
      misc: string[];
    }
  >();

  for (const transitionItem of asArray(sourceObj.transitions)) {
    const transitionObj = asObject(transitionItem);
    if (!transitionObj) continue;

    const from = asNumber(transitionObj.from);
    const to = asNumber(transitionObj.to);
    if (from === null || to === null) continue;

    const fromId = String(from);
    const toId = String(to);
    stateSet.add(fromId);
    stateSet.add(toId);

    const key = `${fromId}->${toId}`;
    const bucket = edgeBuckets.get(key) ?? { from: fromId, to: toId, chars: [], misc: [] };
    const asChar = asString(transitionObj.char);
    if (asChar && asChar.length === 1) {
      bucket.chars.push(asChar);
    } else {
      bucket.misc.push(transitionLabel(transitionObj));
    }
    edgeBuckets.set(key, bucket);
  }

  for (const bucket of edgeBuckets.values()) {
    const parts: string[] = [];
    if (bucket.chars.length > 0) {
      parts.push(formatCharSetLabel(bucket.chars, dfaEdgeLabelMode));
    }
    if (bucket.misc.length > 0) {
      parts.push(Array.from(new Set(bucket.misc)).join(", "));
    }
    edges.push({
      from: bucket.from,
      to: bucket.to,
      label: parts.join(" "),
    });
  }

  for (const sid of stateSet) {
    if (nodes.some((node) => node.id === sid)) {
      continue;
    }
    const numeric = Number(sid);
    nodes.push({
      id: sid,
      label: `q${sid}`,
      isStart: startState === numeric,
      isAccept: acceptSingle === numeric || acceptStatesMulti.has(numeric),
    });
  }

  nodes.sort((a, b) => Number(a.id) - Number(b.id));
  edges.sort((a, b) => {
    const fromDiff = Number(a.from) - Number(b.from);
    if (fromDiff !== 0) return fromDiff;
    return Number(a.to) - Number(b.to);
  });
  if (nodes.length === 0) {
    return null;
  }

  return { title, nodes, edges };
}

function buildAutomatonPanels(
  action: YalexAction,
  payload: unknown,
  dfaEdgeLabelMode: DfaEdgeLabelMode
): GraphPanel[] {
  const root = asObject(payload);
  if (!root) return [];

  if (action === "dfa") {
    const dfa = asObject(root.dfa);
    const panel = dfa ? buildSingleAutomatonPanel(dfa, "DFA", true, dfaEdgeLabelMode) : null;
    return panel ? [panel] : [];
  }

  return [];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseSavedSizes(raw: string | null): PanelSizes | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PanelSizes>;
    if (
      typeof parsed.sidebarWidth !== "number" ||
      typeof parsed.rightPanelWidth !== "number" ||
      typeof parsed.resultPanelHeight !== "number" ||
      typeof parsed.outputPanelHeight !== "number"
    ) {
      return null;
    }

    return {
      sidebarWidth: clamp(parsed.sidebarWidth, 260, 560),
      rightPanelWidth: clamp(parsed.rightPanelWidth, 260, 560),
      resultPanelHeight: clamp(parsed.resultPanelHeight, 160, 500),
      outputPanelHeight: clamp(parsed.outputPanelHeight, 120, 440),
    };
  } catch {
    return null;
  }
}

function nowTime(): string {
  return new Date().toLocaleTimeString();
}

function isTextFile(name: string): boolean {
  const lowered = name.toLowerCase();
  return (
    lowered.endsWith(".py") ||
    lowered.endsWith(".rs") ||
    lowered.endsWith(".toml") ||
    lowered.endsWith(".lock") ||
    lowered.endsWith(".md") ||
    lowered.endsWith(".txt") ||
    lowered.endsWith(".yal") ||
    lowered.endsWith(".yalp") ||
    lowered.endsWith(".yaml") ||
    lowered.endsWith(".yml") ||
    lowered.endsWith(".json") ||
    lowered.endsWith(".sh")
  );
}

function inferSeparator(path: string): "\\" | "/" {
  return path.includes("\\") ? "\\" : "/";
}

function trimTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function joinPath(base: string, ...segments: string[]): string {
  const sep = inferSeparator(base || "");
  const cleanedBase = trimTrailingSeparators(base);
  const cleanedSegments = segments.map((segment) => segment.replace(/^[\\/]+|[\\/]+$/g, ""));
  return [cleanedBase, ...cleanedSegments].filter(Boolean).join(sep);
}

function getPathBaseName(path: string): string {
  if (!path) {
    return "";
  }
  const normalized = path.replace(/[/\\]+$/, "");
  const parts = normalized.split(/[/\\]/);
  return parts[parts.length - 1] || normalized;
}

function getParentPath(path: string): string {
  if (!path) {
    return "";
  }
  const normalized = trimTrailingSeparators(path);
  const parts = normalized.split(/[\\/]/);
  if (parts.length <= 1) {
    return normalized;
  }
  const sep = inferSeparator(normalized);
  return parts.slice(0, -1).join(sep);
}

function languageFromFileName(name: string): string {
  const lowered = name.toLowerCase();
  if (lowered.endsWith(".py")) return "python";
  if (lowered.endsWith(".rs")) return "rust";
  if (lowered.endsWith(".md")) return "markdown";
  if (lowered.endsWith(".json")) return "json";
  if (lowered.endsWith(".yaml") || lowered.endsWith(".yml")) return "yaml";
  if (lowered.endsWith(".toml")) return "ini";
  if (lowered.endsWith(".sh")) return "shell";
  if (lowered.endsWith(".txt") || lowered.endsWith(".lock") || lowered.endsWith(".yal") || lowered.endsWith(".yalp")) {
    return "plaintext";
  }
  return "plaintext";
}

function registerEditorTheme(monaco: Monaco) {
  monaco.editor.defineTheme("yalex-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "keyword", foreground: "7CC7FF" },
      { token: "keyword.control", foreground: "7CC7FF" },
      { token: "type", foreground: "84E1BC" },
      { token: "string", foreground: "E6C07B" },
      { token: "number", foreground: "EFA8FF" },
      { token: "comment", foreground: "6F7D9A", fontStyle: "italic" },
      { token: "function", foreground: "5CE086" },
      { token: "delimiter", foreground: "A9C3FF" },
      { token: "operator", foreground: "36C3FF" },
    ],
    colors: {
      "editor.background": "#0F1521",
      "editor.foreground": "#DBE4FF",
      "editor.lineHighlightBackground": "#182238",
      "editorCursor.foreground": "#36C3FF",
      "editor.selectionBackground": "#2A3B63",
      "editor.inactiveSelectionBackground": "#223352",
      "editorLineNumber.foreground": "#607194",
      "editorLineNumber.activeForeground": "#A9C3FF",
      "editorIndentGuide.background1": "#1D2B46",
      "editorIndentGuide.activeBackground1": "#35507D",
      "editorWhitespace.foreground": "#24324E",
    },
  });
}

export function App() {
  const workbenchSplitRef = useRef<HTMLDivElement | null>(null);
  const outputLogRef = useRef<HTMLDivElement | null>(null);
  const yaparScrollRef = useRef<HTMLDivElement | null>(null);
  const yaparZoomAnchorRef = useRef<{
    contentX: number;
    contentY: number;
    viewportX: number;
    viewportY: number;
    zoom: number;
  } | null>(null);
  const yaparDetailScrollRef = useRef<HTMLDivElement | null>(null);
  const yaparDetailScrollRestoreRef = useRef<{ left: number; top: number } | null>(null);
  const yaparScrollRestoreRef = useRef<{ left: number; top: number } | null>(null);
  const restoredSizes = useMemo(
    () =>
      parseSavedSizes(
        typeof window === "undefined" ? null : window.localStorage.getItem(PANEL_STORAGE_KEY)
      ),
    []
  );

  const [workspaceRoot, setWorkspaceRoot] = useState<string>("");
  const [treeMap, setTreeMap] = useState<Record<string, FileNode[]>>({});
  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({});
  const [selectedPath, setSelectedPath] = useState<string>("");

  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string>("");

  const [output, setOutput] = useState<OutputItem[]>([]);
  const [latestResult, setLatestResult] = useState<string>("Sin resultados todavía.");
  const [isOutputVisible, setIsOutputVisible] = useState<boolean>(true);
  const [activeWorkflow, setActiveWorkflow] = useState<"yalex" | "yapar">("yalex");
  const [actionResults, setActionResults] = useState<Partial<Record<AnyAction, string>>>({});
  const [actionResultObjects, setActionResultObjects] = useState<
    Partial<Record<AnyAction, unknown>>
  >({});
  const [activeResultAction, setActiveResultAction] = useState<AnyAction | null>(null);
  const [resultViewMode, setResultViewMode] = useState<"json" | "graph" | "code">("graph");
  const [generatedPythonCode, setGeneratedPythonCode] = useState<string>("");
  const [isLoadingGeneratedCode, setIsLoadingGeneratedCode] = useState<boolean>(false);
  const [dfaEdgeLabelMode, setDfaEdgeLabelMode] = useState<DfaEdgeLabelMode>("ranges");
  const [dfaLabelDensity, setDfaLabelDensity] = useState<DfaLabelDensity>("compact");
  const [hoveredEdgeKey, setHoveredEdgeKey] = useState<string | null>(null);
  const [validationChecks, setValidationChecks] = useState<ValidationCheck[]>([]);
  const [validationRunAt, setValidationRunAt] = useState<string>("");
  const [yaparZoom, setYaparZoom] = useState<number>(1);

  const [yalFilePath, setYalFilePath] = useState<string>("");
  const [yaparFilePath, setYaparFilePath] = useState<string>("");
  const [inputFilePath, setInputFilePath] = useState<string>("");
  const [generateOutputPath, setGenerateOutputPath] = useState<string>("");
  const [generateParserOutputPath, setGenerateParserOutputPath] = useState<string>("");
  const [yaparSelectedStateId, setYaparSelectedStateId] = useState<number | null>(null);
  const [isRunningAction, setIsRunningAction] = useState<boolean>(false);
  const [leftSidebarView, setLeftSidebarView] = useState<"explorer" | "pipeline" | "results">("explorer");
  const [isInitializing, setIsInitializing] = useState<boolean>(true); // Show loading state while Tauri initializes
  const [initError, setInitError] = useState<string>(""); // Track initialization errors
  const [sidebarWidth, setSidebarWidth] = useState<number>(
    restoredSizes?.sidebarWidth ? Math.round(restoredSizes.sidebarWidth * 1.25) : Math.round(340 * 1.25)
  );
  const [rightPanelWidth, setRightPanelWidth] = useState<number>(
    restoredSizes?.rightPanelWidth ?? 340
  );
  const [resultPanelHeight, setResultPanelHeight] = useState<number>(
    restoredSizes?.resultPanelHeight ?? 270
  );
  const [outputPanelHeight, setOutputPanelHeight] = useState<number>(
    restoredSizes?.outputPanelHeight ?? 180
  );
  const [resizeState, setResizeState] = useState<{
    target: "sidebar" | "rightPanel" | "resultPanel" | "outputPanel";
    startX: number;
    startY: number;
    startSidebarWidth: number;
    startRightPanelWidth: number;
    startResultPanelHeight: number;
    startOutputPanelHeight: number;
  } | null>(null);
  const [pendingCreate, setPendingCreate] = useState<{
    type: "file" | "folder";
    parentDir: string;
    draftName: string;
  } | null>(null);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.path === activeTabPath) ?? null,
    [tabs, activeTabPath]
  );

  // Activity bar scaling factor (0.8 = 80% of baseline 81px)
  const activityBarScale = 0.8;
  const activityBarWidth = Math.round(81 * activityBarScale);

  const visibleResultActions = useMemo(
    () => {
      const allActions = activeWorkflow === "yalex" ? FULL_PIPELINE_ACTIONS : YAPAR_PIPELINE_ACTIONS;
      return allActions.filter((action) => Boolean(actionResults[action]));
    },
    [actionResults, activeWorkflow]
  );

  const activeResultText =
    activeResultAction && actionResults[activeResultAction]
      ? actionResults[activeResultAction]
      : latestResult;

  const activeResultObject = activeResultAction ? actionResultObjects[activeResultAction] : null;
  const effectiveOutputPanelHeight = isOutputVisible ? outputPanelHeight : 0;

  const updateYaparZoom = (
    computeNext: (current: number) => number,
    anchorClient?: { x: number; y: number }
  ) => {
    const container = yaparScrollRef.current;
    setYaparZoom((current) => {
      const next = Math.min(2, Math.max(0.2, Math.round(computeNext(current) * 10) / 10));
      if (next === current) {
        return current;
      }

      if (container) {
        const rect = container.getBoundingClientRect();
        const viewportX = anchorClient
          ? Math.min(Math.max(anchorClient.x - rect.left, 0), rect.width)
          : rect.width / 2;
        const viewportY = anchorClient
          ? Math.min(Math.max(anchorClient.y - rect.top, 0), rect.height)
          : rect.height / 2;

        yaparZoomAnchorRef.current = {
          contentX: container.scrollLeft + viewportX,
          contentY: container.scrollTop + viewportY,
          viewportX,
          viewportY,
          zoom: current,
        };
      } else {
        yaparZoomAnchorRef.current = null;
      }

      return next;
    });
  };

  const handleYaparWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    // Zoom only with Ctrl + wheel.
    const shouldZoom = e.ctrlKey;
    if (!shouldZoom) {
      return;
    }
    e.preventDefault();
    const step = 0.1;
    const change = e.deltaY > 0 ? -step : step;
    updateYaparZoom((current) => current + change, { x: e.clientX, y: e.clientY });
  };
  const increaseYaparZoom = () => {
    updateYaparZoom((current) => current + 0.1);
  };
  const decreaseYaparZoom = () => {
    updateYaparZoom((current) => current - 0.1);
  };
  const resetYaparZoom = () => {
    updateYaparZoom(() => 1);
  };
  const captureYaparDetailScroll = () => {
    if (!yaparDetailScrollRef.current) {
      return;
    }
    yaparDetailScrollRestoreRef.current = {
      left: yaparDetailScrollRef.current.scrollLeft,
      top: yaparDetailScrollRef.current.scrollTop,
    };
  };

  const captureYaparScroll = () => {
    if (!yaparScrollRef.current) {
      return;
    }
    yaparScrollRestoreRef.current = {
      left: yaparScrollRef.current.scrollLeft,
      top: yaparScrollRef.current.scrollTop,
    };
  };

  const graphSupportedActions: AnyAction[] = ["ast", "dfa", "combinedNfa", "yaparAutomaton"];
  const canRenderGraph = Boolean(
    activeResultAction && graphSupportedActions.includes(activeResultAction) && activeResultObject
  );
  const generateRoot = activeResultAction === "generate" ? asObject(activeResultObject) : null;
  const generatedOutputPath = generateRoot ? asString(generateRoot.outputPath) : null;

  const yaparGenerateRoot = activeResultAction === "yaparGenerate" ? asObject(activeResultObject) : null;
  const yaparGeneratedOutputPath = yaparGenerateRoot ? asString(yaparGenerateRoot.outputPath) : null;

  useEffect(() => {
    if (!yaparZoomAnchorRef.current || !yaparScrollRef.current) {
      return;
    }

    const anchor = yaparZoomAnchorRef.current;
    yaparZoomAnchorRef.current = null;
    const zoomRatio = yaparZoom / (anchor.zoom || 1);

    requestAnimationFrame(() => {
      if (!yaparScrollRef.current) {
        return;
      }

      const targetLeft = anchor.contentX * zoomRatio - anchor.viewportX;
      const targetTop = anchor.contentY * zoomRatio - anchor.viewportY;
      const maxLeft = Math.max(0, yaparScrollRef.current.scrollWidth - yaparScrollRef.current.clientWidth);
      const maxTop = Math.max(0, yaparScrollRef.current.scrollHeight - yaparScrollRef.current.clientHeight);

      yaparScrollRef.current.scrollLeft = Math.min(Math.max(targetLeft, 0), maxLeft);
      yaparScrollRef.current.scrollTop = Math.min(Math.max(targetTop, 0), maxTop);
    });
  }, [yaparZoom]);

  useEffect(() => {
    if (!yaparDetailScrollRestoreRef.current || !yaparDetailScrollRef.current) {
      return;
    }

    const { left, top } = yaparDetailScrollRestoreRef.current;
    yaparDetailScrollRestoreRef.current = null;

    requestAnimationFrame(() => {
      if (!yaparDetailScrollRef.current) {
        return;
      }
      yaparDetailScrollRef.current.scrollLeft = left;
      yaparDetailScrollRef.current.scrollTop = top;
    });
  }, [yaparSelectedStateId]);

  useEffect(() => {
    if (!yaparScrollRestoreRef.current || !yaparScrollRef.current) {
      return;
    }

    const { left, top } = yaparScrollRestoreRef.current;
    yaparScrollRestoreRef.current = null;

    requestAnimationFrame(() => {
      if (!yaparScrollRef.current) {
        return;
      }
      const maxLeft = Math.max(0, yaparScrollRef.current.scrollWidth - yaparScrollRef.current.clientWidth);
      const maxTop = Math.max(0, yaparScrollRef.current.scrollHeight - yaparScrollRef.current.clientHeight);
      yaparScrollRef.current.scrollLeft = Math.min(Math.max(left, 0), maxLeft);
      yaparScrollRef.current.scrollTop = Math.min(Math.max(top, 0), maxTop);
    });
  }, [yaparSelectedStateId]);

  const generatedCodePathCandidates = useMemo(() => {
    if (activeResultAction !== "generate" && activeResultAction !== "yaparGenerate") {
      return [] as string[];
    }

    const candidates: string[] = [];
    if (activeResultAction === "generate") {
      if (generatedOutputPath?.trim()) {
        candidates.push(generatedOutputPath.trim());
      }
      if (generateOutputPath.trim()) {
        candidates.push(generateOutputPath.trim());
      }
      const sourcePath = generatedOutputPath?.trim() || generateOutputPath.trim();
      const baseName = sourcePath ? getPathBaseName(sourcePath) : "";
      if (workspaceRoot && baseName) {
        candidates.push(joinPath(workspaceRoot, "output", baseName));
        candidates.push(joinPath(workspaceRoot, baseName));
      }
    } else {
      if (yaparGeneratedOutputPath?.trim()) {
        candidates.push(yaparGeneratedOutputPath.trim());
      }
      if (generateParserOutputPath.trim()) {
        candidates.push(generateParserOutputPath.trim());
      }
      const sourcePath = yaparGeneratedOutputPath?.trim() || generateParserOutputPath.trim();
      const baseName = sourcePath ? getPathBaseName(sourcePath) : "";
      if (workspaceRoot && baseName) {
        candidates.push(joinPath(workspaceRoot, "output", baseName));
        candidates.push(joinPath(workspaceRoot, baseName));
      }
    }

    return Array.from(new Set(candidates.filter(Boolean)));
  }, [activeResultAction, generatedOutputPath, generateOutputPath, yaparGeneratedOutputPath, generateParserOutputPath, workspaceRoot]);
  const canRenderCode = generatedCodePathCandidates.length > 0;

  const passedChecks = validationChecks.filter((check) => check.ok).length;
  const totalChecks = validationChecks.length;
  const canRunFullPipeline = Boolean(workspaceRoot && yalFilePath.trim() && inputFilePath.trim() && !isRunningAction);
  const canRunYaparPipeline = Boolean(
    workspaceRoot && yaparFilePath.trim() && yalFilePath.trim() && inputFilePath.trim() && !isRunningAction
  );

  useEffect(() => {
    if (resultViewMode !== "code") {
      return;
    }

    if (!canRenderCode) {
      setGeneratedPythonCode("");
      return;
    }

    let cancelled = false;
    setIsLoadingGeneratedCode(true);

    const loadGeneratedCode = async () => {
      let lastError: unknown = null;
      for (const candidatePath of generatedCodePathCandidates) {
        try {
          const content = await readTextFile(candidatePath);
          if (!cancelled) {
            setGeneratedPythonCode(content);
          }
          return;
        } catch (error) {
          lastError = error;
        }
      }

      if (!cancelled) {
        const attempted = generatedCodePathCandidates.join(" | ");
        setGeneratedPythonCode(
          `No se pudo leer el lexer generado. Rutas intentadas: ${attempted}. Error: ${String(lastError)}`
        );
      }
    };

    void loadGeneratedCode().finally(() => {
      if (!cancelled) {
        setIsLoadingGeneratedCode(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [resultViewMode, canRenderCode, generatedCodePathCandidates]);

  function buildValidationChecks(
    results: Partial<Record<YalexAction, unknown>>
  ): ValidationCheck[] {
    const tokenize = asObject(results.tokenize);
    const tokens = tokenize ? asArray(tokenize.tokens) : [];
    const errors = tokenize ? asArray(tokenize.errors) : [];
    const lexicalFailureDetected = errors.length > 0;

    return [
      {
        id: "tokenize",
        label: "Tokenización ejecutada",
        ok: Boolean(tokenize && Array.isArray(tokenize.tokens) && Array.isArray(tokenize.errors)),
        detail: tokenize
          ? `tokens=${tokens.length}, errors=${errors.length}`
          : "Ejecuta la etapa Tokenizar para validar el fallo léxico",
      },
      {
        id: "combinedNfa",
        label: "Fallo léxico real detectado",
        ok: lexicalFailureDetected,
        detail: lexicalFailureDetected
          ? "Sí: la lista errors contiene elementos"
          : "No: errors está vacío para la última tokenización",
      },
      {
        id: "generate",
        label: "Comportamiento esperado en lexer generado",
        ok: lexicalFailureDetected,
        detail: lexicalFailureDetected
          ? "Con esos errors, el lexer generado terminaría con código 1 en main"
          : "Si no hay errors, el lexer generado terminaría sin fallo léxico",
      },
    ];
  }

  function runValidationFromCurrentResults() {
    const checks = buildValidationChecks(actionResultObjects);
    setValidationChecks(checks);
    const passCount = checks.filter((check) => check.ok).length;
    setValidationRunAt(nowTime());
    if (passCount === checks.length) {
      pushOutput("ok", `Validación completa OK (${passCount}/${checks.length}).`);
    } else {
      pushOutput("error", `Validación con fallos (${passCount}/${checks.length}).`);
    }
  }

  async function runGeneratedLexerProgram() {
    if (!workspaceRoot) {
      pushOutput("error", "No hay workspace abierto.");
      return;
    }
    if (!generateOutputPath.trim()) {
      pushOutput("error", "Debe indicar la ruta del lexer generado (.py).");
      return;
    }
    if (!inputFilePath.trim()) {
      pushOutput("error", "Debe indicar la ruta del input (.txt).");
      return;
    }

    try {
      setIsRunningAction(true);
      pushOutput("info", "Ejecutando lexer generado...");

      const response = await runYalex({
        workspaceRoot,
        action: "executeGeneratedLexer",
        lexerPath: generateOutputPath,
        inputPath: inputFilePath,
      });

      const parsed = response as { ok: boolean; result?: unknown; error?: string };
      if (!parsed.ok) {
        pushOutput("error", parsed.error || "Error ejecutando lexer generado.");
        return;
      }

      const result = (parsed.result ?? {}) as Record<string, unknown>;
      const success = Boolean(result.success);
      const exitCode = Number(result.exitCode ?? -1);
      const tokenCount = Number(result.tokenCount ?? 0);
      const lexicalErrorCount = Number(result.lexicalErrorCount ?? 0);

      const formatted = JSON.stringify(parsed.result, null, 2);
      setLatestResult(formatted);
      setActionResults((prev) => ({ ...prev, executeGeneratedLexer: formatted }));
      setActionResultObjects((prev) => ({ ...prev, executeGeneratedLexer: parsed.result }));
      setActiveResultAction("executeGeneratedLexer");

      if (success) {
        pushOutput(
          "ok",
          `Lexer generado ejecutado correctamente (exit=${exitCode}, tokens=${tokenCount}, errors=${lexicalErrorCount}).`
        );
      } else {
        pushOutput(
          "error",
          `Lexer generado terminó con fallo (exit=${exitCode}, tokens=${tokenCount}, errors=${lexicalErrorCount}).`
        );
      }
    } catch (error) {
      pushOutput("error", `Fallo ejecutando lexer generado: ${String(error)}`);
    } finally {
      setIsRunningAction(false);
    }
  }

  function cloneAstNode(node: unknown): unknown {
    return JSON.parse(JSON.stringify(node));
  }

  function normalizeAstForDisplay(node: unknown): unknown {
    const obj = asObject(node);
    if (!obj) {
      return node;
    }

    const type = asString(obj.type) ?? "";

    if (type === "concat") {
      const parts = asArray(obj.parts).map((part) => normalizeAstForDisplay(part));
      if (parts.length <= 1) {
        return parts[0] ?? obj;
      }

      let acc = parts[0];
      for (let index = 1; index < parts.length; index++) {
        acc = {
          type: "binary",
          operator: ".",
          left: acc,
          right: parts[index],
        };
      }
      return acc;
    }

    if (type === "unary") {
      const operator = asString(obj.operator) ?? "";
      const operand = normalizeAstForDisplay(obj.operand);

      if (operator === "+") {
        // Desugar a+ as CONCAT(a, KLEENE(a)) for fundamental-ops view.
        return {
          type: "binary",
          operator: ".",
          left: operand,
          right: {
            type: "unary",
            operator: "*",
            operand: cloneAstNode(operand),
          },
        };
      }

      return {
        ...obj,
        operand,
      };
    }

    if (type === "binary") {
      return {
        ...obj,
        left: normalizeAstForDisplay(obj.left),
        right: normalizeAstForDisplay(obj.right),
      };
    }

    return obj;
  }

  function astNodeLabel(node: unknown): string {
    const obj = asObject(node);
    if (!obj) {
      return "?";
    }

    const type = asString(obj.type) ?? "node";

    if (type === "binary") {
      const operator = asString(obj.operator) ?? "?";
      if (operator === ".") return "•";
      if (operator === "|" || operator === "/") return "|";
      if (operator === "#") return "#";
      return operator;
    }

    if (type === "unary") {
      const operator = asString(obj.operator) ?? "?";
      if (operator === "*") return "*";
      if (operator === "+") return "+";
      if (operator === "?") return "?";
      return operator;
    }

    if (type === "literal") {
      return asString(obj.value) ?? "LITERAL";
    }

    if (type === "identifier") {
      return asString(obj.name) ?? "IDENTIFIER";
    }

    if (type === "string") {
      return `"${asString(obj.value) ?? ""}"`;
    }

    if (type === "charset") {
      return Boolean(obj.negated) ? "[^]" : "[]";
    }

    if (type === "wildcard") {
      return "_";
    }

    if (type === "concat") {
      return "•";
    }

    return type;
  }

  function astChildren(node: unknown): unknown[] {
    const obj = asObject(node);
    if (!obj) {
      return [];
    }

    const type = asString(obj.type) ?? "";
    if (type === "binary") {
      const children: unknown[] = [];
      if (obj.left) children.push(obj.left);
      if (obj.right) children.push(obj.right);
      return children;
    }

    if (type === "unary") {
      return obj.operand ? [obj.operand] : [];
    }

    if (type === "concat") {
      return asArray(obj.parts);
    }

    return [];
  }

  function appendEndMarkerForDirectMethod(node: unknown): unknown {
    const normalized = normalizeAstForDisplay(node);
    const root = asObject(normalized);

    if (
      root &&
      asString(root.type) === "binary" &&
      asString(root.operator) === "." &&
      asObject(root.right) &&
      asString(asObject(root.right)?.type) === "identifier" &&
      asString(asObject(root.right)?.name) === "$END$"
    ) {
      return normalized;
    }

    return {
      type: "binary",
      operator: ".",
      left: normalized,
      right: {
        type: "identifier",
        name: "$END$",
      },
    };
  }

  function renderAstVisualTree(node: unknown, keyPrefix: string): JSX.Element {
    const label = astNodeLabel(node);
    const children = astChildren(node);

    return (
      <li key={keyPrefix} className="ast-vis-item">
        <div className="ast-vis-node">{label}</div>
        {children.length > 0 && (
          <ul className="ast-vis-children">
            {children.map((child, index) => renderAstVisualTree(child, `${keyPrefix}-${index}`))}
          </ul>
        )}
      </li>
    );
  }

  function renderAstGraph(payload: unknown): JSX.Element {
    const root = asObject(payload);
    const regexAst = root ? asObject(root.regex_ast) : null;
    if (!regexAst) {
      return <div className="graph-empty">No hay estructura AST para renderizar.</div>;
    }

    const sections: JSX.Element[] = [];

    const combinedAlternativeAsts = asArray(regexAst.rule_alternatives)
      .map((altItem) => asObject(altItem))
      .filter((altObj): altObj is Record<string, unknown> => altObj !== null)
      .map((altObj) => appendEndMarkerForDirectMethod(altObj.ast));

    if (combinedAlternativeAsts.length > 0) {
      const combinedRoot = combinedAlternativeAsts.reduce((acc, current) => {
        if (acc === null) return current;
        return {
          type: "binary",
          operator: "|",
          left: acc,
          right: current,
        };
      }, null as unknown);

      sections.push(
        <section key="ast-combined-direct" className="graph-panel">
          <h4>AST combinado (metodo directo)</h4>
          <div className="ast-vis-wrap">
            <ul className="ast-vis-tree">{renderAstVisualTree(combinedRoot, "combined-direct")}</ul>
          </div>
        </section>
      );
    }

    for (const altItem of asArray(regexAst.rule_alternatives)) {
      const altObj = asObject(altItem);
      if (!altObj) continue;
      const index = asNumber(altObj.index);
      const astWithEnd = appendEndMarkerForDirectMethod(altObj.ast);
      sections.push(
        <section key={`alt-${index ?? "?"}`} className="graph-panel">
          <h4>{`AST alternativa ${index ?? "?"}`}</h4>
          <div className="ast-vis-wrap">
            <ul className="ast-vis-tree">
              {renderAstVisualTree(astWithEnd, `alt-${index ?? "?"}`)}
            </ul>
          </div>
        </section>
      );
    }

    return <div className="graph-panels">{sections.length > 0 ? sections : <div className="graph-empty">Sin nodos AST.</div>}</div>;
  }

  function formatPositionSet(value: unknown): string {
    const positions = asArray(value)
      .map((item) => asNumber(item))
      .filter((item): item is number => item !== null)
      .sort((a, b) => a - b);

    return `{${positions.join(", ")}}`;
  }

  function renderDirectConstructionView(payload: unknown): JSX.Element {
    const root = asObject(payload);
    const direct = root ? asObject(root.direct_construction) : null;
    if (!direct) {
      return <div className="graph-empty">No hay artefactos de construcción directa disponibles.</div>;
    }

    const rootNullable = Boolean(direct.root_nullable);
    const rootFirstpos = formatPositionSet(direct.root_firstpos);
    const rootLastpos = formatPositionSet(direct.root_lastpos);
    const startPositions = formatPositionSet(direct.start_positions);
    const alphabetSize = asNumber(direct.alphabet_size) ?? 0;

    const followRaw = asObject(direct.followpos) ?? {};
    const followEntries = Object.entries(followRaw)
      .map(([position, targets]) => ({
        position: Number(position),
        targets: formatPositionSet(targets),
      }))
      .sort((a, b) => a.position - b.position);

    const positions = asArray(direct.positions)
      .map((item) => asObject(item))
      .filter((item): item is Record<string, unknown> => item !== null)
      .sort((a, b) => (asNumber(a.position) ?? 0) - (asNumber(b.position) ?? 0));

    const nodeMetrics = asArray(direct.node_metrics)
      .map((item) => asObject(item))
      .filter((item): item is Record<string, unknown> => item !== null)
      .map((item) => ({
        nodeId: asNumber(item.node_id) ?? -1,
        label: asString(item.label) ?? "?",
        nullable: Boolean(item.nullable),
        firstposRaw: asArray(item.firstpos)
          .map((value) => asNumber(value))
          .filter((value): value is number => value !== null)
          .sort((a, b) => a - b),
        lastposRaw: asArray(item.lastpos)
          .map((value) => asNumber(value))
          .filter((value): value is number => value !== null)
          .sort((a, b) => a - b),
        firstpos: formatPositionSet(item.firstpos),
        lastpos: formatPositionSet(item.lastpos),
        children: asArray(item.children)
          .map((child) => asNumber(child))
          .filter((child): child is number => child !== null)
          .sort((a, b) => a - b),
      }))
      .sort((a, b) => a.nodeId - b.nodeId);

    const followByPosition = new Map<number, string>();
    for (const entry of followEntries) {
      followByPosition.set(entry.position, entry.targets);
    }

    const leafByPosition = new Map<number, { chars: string; marker: string }>();
    for (const item of positions) {
      const position = asNumber(item.position) ?? -1;
      if (position < 0) continue;

      const chars = asArray(item.chars)
        .map((ch) => asString(ch))
        .filter((ch): ch is string => ch !== null)
        .map((ch) => formatCharLabel(ch));
      const isAcceptMarker = Boolean(item.is_accept_marker);
      const markerLabel = isAcceptMarker
        ? `${asString(item.label) ?? "token"} (prio ${asNumber(item.priority) ?? "?"})`
        : "-";

      leafByPosition.set(position, {
        chars: chars.length > 0 ? chars.join(" ") : "[]",
        marker: markerLabel,
      });
    }

    return (
      <div className="direct-view">
        <div className="direct-summary-grid">
          <section className="direct-card">
            <h4>Analisis Raiz</h4>
            <div className="direct-kv"><strong>nullable:</strong> {rootNullable ? "true" : "false"}</div>
            <div className="direct-kv"><strong>firstpos:</strong> {rootFirstpos}</div>
            <div className="direct-kv"><strong>lastpos:</strong> {rootLastpos}</div>
          </section>
          <section className="direct-card">
            <h4>Inicializacion</h4>
            <div className="direct-kv"><strong>start_positions:</strong> {startPositions}</div>
            <div className="direct-kv"><strong>alphabet_size:</strong> {alphabetSize}</div>
          </section>
        </div>

        <section className="direct-card">
          <h4>Tabla Completa (Arbol Combinado)</h4>
          <div className="direct-table-wrap">
            <table className="direct-table">
              <thead>
                <tr>
                  <th>Nodo</th>
                  <th>Pos</th>
                  <th>Label</th>
                  <th>nullable</th>
                  <th>firstpos</th>
                  <th>lastpos</th>
                  <th>followpos</th>
                  <th>chars</th>
                  <th>marker</th>
                  <th>children</th>
                </tr>
              </thead>
              <tbody>
                {nodeMetrics.map((entry) => {
                  const isLeafPosition =
                    entry.children.length === 0 &&
                    entry.firstposRaw.length === 1 &&
                    entry.lastposRaw.length === 1 &&
                    entry.firstposRaw[0] === entry.lastposRaw[0];

                  const position = isLeafPosition ? entry.firstposRaw[0] : null;
                  const displayPosition = position !== null ? String(position) : "-";
                  const followpos = position !== null ? (followByPosition.get(position) ?? "{}") : "-";
                  const leafMeta = position !== null ? leafByPosition.get(position) : undefined;
                  const chars = leafMeta?.chars ?? "-";
                  const marker = leafMeta?.marker ?? "-";

                  return (
                    <tr key={`node-${entry.nodeId}`}>
                      <td>{entry.nodeId}</td>
                      <td>{displayPosition}</td>
                      <td>{entry.label}</td>
                      <td>{entry.nullable ? "true" : "false"}</td>
                      <td>{entry.firstpos}</td>
                      <td>{entry.lastpos}</td>
                      <td>{followpos}</td>
                      <td>{chars}</td>
                      <td>{marker}</td>
                      <td>{entry.children.length > 0 ? `{${entry.children.join(", ")}}` : "{}"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    );
  }

  function renderAutomatonSvg(panel: GraphPanel): JSX.Element {
    const width = 820;
    const height = 340;
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.max(90, Math.min(130, 28 * panel.nodes.length));
    const nodeRadius = 20;
    const markerId = `arrow-${panel.title.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

    const positions = new Map<string, { x: number; y: number }>();
    panel.nodes.forEach((node, index) => {
      const angle = (2 * Math.PI * index) / panel.nodes.length - Math.PI / 2;
      positions.set(node.id, {
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
      });
    });

    const edgeKeySet = new Set(panel.edges.map((edge) => `${edge.from}->${edge.to}`));
    const edgeLabels: Array<{ key: string; x: number; y: number; label: string }> = [];

    return (
      <section key={panel.title} className="graph-panel">
        <h4>{panel.title}</h4>
        <div className="graph-canvas-wrap">
          <svg viewBox={`0 0 ${width} ${height}`} className="automaton-svg" aria-label={panel.title}>
            <defs>
              <marker id={markerId} markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
                <polygon points="0 0, 10 3.5, 0 7" />
              </marker>
            </defs>

            {panel.edges.map((edge, index) => {
              const edgeKey = `${edge.from}-${edge.to}-${index}`;
              const from = positions.get(edge.from);
              const to = positions.get(edge.to);
              if (!from || !to) return null;

              if (edge.from === edge.to) {
                const loopRadius = nodeRadius + 14;
                const startX = from.x + nodeRadius * 0.7;
                const startY = from.y - nodeRadius * 0.7;
                const endX = from.x - nodeRadius * 0.7;
                const endY = from.y - nodeRadius * 0.7;
                const c1x = from.x + loopRadius;
                const c1y = from.y - loopRadius - 24;
                const c2x = from.x - loopRadius;
                const c2y = from.y - loopRadius - 24;
                const labelX = from.x;
                const labelY = from.y - loopRadius - 28;

                edgeLabels.push({ key: edgeKey, x: labelX, y: labelY, label: edge.label });

                return (
                  <g key={edgeKey} className="graph-edge-group">
                    <path
                      d={`M ${startX} ${startY} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${endX} ${endY}`}
                      className={`graph-edge ${hoveredEdgeKey === edgeKey ? "is-hovered" : ""}`}
                      markerEnd={`url(#${markerId})`}
                      fill="none"
                      onMouseEnter={() => setHoveredEdgeKey(edgeKey)}
                      onMouseLeave={() =>
                        setHoveredEdgeKey((prev) => (prev === edgeKey ? null : prev))
                      }
                    />
                  </g>
                );
              }

              const dx = to.x - from.x;
              const dy = to.y - from.y;
              const distance = Math.hypot(dx, dy);
              if (distance < 0.001) {
                return null;
              }

              const ux = dx / distance;
              const uy = dy / distance;
              const edgePadding = 2;
              const startX = from.x + ux * (nodeRadius + edgePadding);
              const startY = from.y + uy * (nodeRadius + edgePadding);
              const endX = to.x - ux * (nodeRadius + edgePadding);
              const endY = to.y - uy * (nodeRadius + edgePadding);

              const reverseExists = edgeKeySet.has(`${edge.to}->${edge.from}`);
              const directionBias = Number(edge.from) <= Number(edge.to) ? 1 : -1;
              const curveOffset = reverseExists ? 18 * directionBias : 0;
              const nx = -uy;
              const ny = ux;
              const controlX = (startX + endX) / 2 + nx * curveOffset;
              const controlY = (startY + endY) / 2 + ny * curveOffset;

              const isCurved = curveOffset !== 0;
              const pathD = isCurved
                ? `M ${startX} ${startY} Q ${controlX} ${controlY} ${endX} ${endY}`
                : `M ${startX} ${startY} L ${endX} ${endY}`;

              const labelX = isCurved ? (startX + 2 * controlX + endX) / 4 : (startX + endX) / 2;
              const labelY = (isCurved ? (startY + 2 * controlY + endY) / 4 : (startY + endY) / 2) - 6;

              edgeLabels.push({ key: edgeKey, x: labelX, y: labelY, label: edge.label });

              return (
                <g key={edgeKey} className="graph-edge-group">
                  <path
                    d={pathD}
                    className={`graph-edge ${hoveredEdgeKey === edgeKey ? "is-hovered" : ""}`}
                    markerEnd={`url(#${markerId})`}
                    fill="none"
                    onMouseEnter={() => setHoveredEdgeKey(edgeKey)}
                    onMouseLeave={() =>
                      setHoveredEdgeKey((prev) => (prev === edgeKey ? null : prev))
                    }
                  />
                </g>
              );
            })}

            {panel.nodes.map((node) => {
              const pos = positions.get(node.id);
              if (!pos) return null;
              const isSelected = activeResultAction === "yaparAutomaton" && yaparSelectedStateId === Number(node.id);
              return (
                <g
                  key={node.id}
                  style={{ cursor: "pointer" }}
                  onClick={() => {
                    if (activeResultAction === "yaparAutomaton") {
                      captureYaparDetailScroll();
                      setYaparSelectedStateId(Number(node.id));
                    }
                  }}
                >
                  <circle
                    cx={pos.x}
                    cy={pos.y}
                    r={nodeRadius}
                    className={`graph-node ${node.isAccept ? "accept" : ""} ${node.isStart ? "start" : ""} ${isSelected ? "selected" : ""}`}
                  />
                  {node.isAccept && <circle cx={pos.x} cy={pos.y} r={nodeRadius - 5} className="graph-node-accept" />}
                  <text x={pos.x} y={pos.y + 4} className="graph-node-label" textAnchor="middle">
                    {node.label}
                  </text>
                </g>
              );
            })}

            {edgeLabels.map((edgeLabel) => {
              const visible =
                dfaLabelDensity === "detailed" ||
                (dfaLabelDensity === "compact" && hoveredEdgeKey === edgeLabel.key);
              if (!visible) {
                return null;
              }

              return (
                <g key={`label-${edgeLabel.key}`}>
                  {renderEdgeLabel(edgeLabel.label, edgeLabel.x, edgeLabel.y, "graph-edge-label", "middle")}
                </g>
              );
            })}
          </svg>
        </div>
      </section>
    );
  }

  function buildYaparAutomatonPanel(data: YaparAutomatonResult): GraphPanel {
    const nodes = data.states.map((state) => {
      const isStart = state.id === 0;
      return {
        id: String(state.id),
        label: `S${state.id}`,
        isStart,
        isAccept: false,
      };
    });

    const edges: GraphEdge[] = [];
    data.states.forEach((state) => {
      Object.entries(state.transitions).forEach(([symbol, targetId]) => {
        edges.push({
          from: String(state.id),
          to: String(targetId),
          label: symbol,
        });
      });
    });

    return {
      title: "Autómata Canónico LR(0)",
      nodes,
      edges,
    };
  }

  function renderYaparAutomatonView(data: YaparAutomatonResult): JSX.Element {
    const cardWidth = 280;
    const cardHeight = 230;
    const count = Math.max(1, data.states.length);
    const radius = Math.max(220, 90 * count);
    const baseWidth = Math.max(980, radius * 2 + cardWidth + 96);
    const baseHeight = Math.max(700, radius * 2 + cardHeight + 96);
    const width = Math.round(baseWidth * yaparZoom);
    const height = Math.round(baseHeight * yaparZoom);
    const cx = baseWidth / 2;
    const cy = baseHeight / 2;
    const markerId = "yapar-arrow";

    const positions = new Map<number, { x: number; y: number }>();
    data.states.forEach((state, index) => {
      const angle = (2 * Math.PI * index) / count - Math.PI / 2;
      positions.set(state.id, {
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
      });
    });

    const selectedState =
      data.states.find((state) => state.id === yaparSelectedStateId) ?? data.states[0] ?? null;

    const getKernelItems = (state: YaparAutomatonResult["states"][number]): string[] =>
      state.kernel_items ?? state.items.filter((item) => !item.includes(" -> . "));
    const getClosureItems = (state: YaparAutomatonResult["states"][number]): string[] =>
      state.closure_items ?? state.items.filter((item) => item.includes(" -> . "));

    return (
      <div className="yapar-automaton-container yapar-automaton-container-rich">
          <div className="yapar-graph-wrapper yapar-graph-wrapper-rich">
          <div
            className="yapar-automaton-scroll"
            ref={yaparScrollRef}
            onWheel={handleYaparWheel}
          >
            <div className="yapar-automaton-stage-viewport" style={{ width, height }}>
              <div
                className="yapar-automaton-stage"
                style={{ width: baseWidth, height: baseHeight, transform: `scale(${yaparZoom})` }}
              >
              <svg className="yapar-transition-layer" viewBox={`0 0 ${baseWidth} ${baseHeight}`} aria-hidden="true">
                <defs>
                  <marker id={markerId} markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
                    <polygon points="0 0, 10 3.5, 0 7" />
                  </marker>
                </defs>

                {/* Precompute transitions and label anchors so we can detect collisions and offset labels */}
                {(() => {
                  const entries: Array<{
                    edgeKey: string;
                    pathD: string;
                    label: string;
                    labelX: number;
                    labelY: number;
                  }> = [];

                  data.states.forEach((state) => {
                    const from = positions.get(state.id);
                    if (!from) return;
                    Object.entries(state.transitions).forEach(([symbol, targetId]) => {
                      const to = positions.get(targetId);
                      if (!to) return;

                      const dx = to.x - from.x;
                      const dy = to.y - from.y;
                      const distance = Math.hypot(dx, dy) || 1;
                      const ux = dx / distance;
                      const uy = dy / distance;
                      const startX = from.x + ux * (cardWidth / 2);
                      const startY = from.y + uy * (cardHeight / 2);
                      const endX = to.x - ux * (cardWidth / 2);
                      const endY = to.y - uy * (cardHeight / 2);
                      const reverseExists = data.states.some(
                        (candidate) => candidate.id === targetId && Object.prototype.hasOwnProperty.call(candidate.transitions, String(state.id))
                      );
                      const directionBias = state.id <= targetId ? 1 : -1;
                      const curveOffset = reverseExists ? 24 * directionBias : 0;
                      const nx = -uy;
                      const ny = ux;
                      const controlX = (startX + endX) / 2 + nx * curveOffset;
                      const controlY = (startY + endY) / 2 + ny * curveOffset;
                      const isCurved = curveOffset !== 0;
                      const pathD = isCurved
                        ? `M ${startX} ${startY} Q ${controlX} ${controlY} ${endX} ${endY}`
                        : `M ${startX} ${startY} L ${endX} ${endY}`;
                      const labelX = isCurved ? (startX + 2 * controlX + endX) / 4 : (startX + endX) / 2;
                      const labelY = (isCurved ? (startY + 2 * controlY + endY) / 4 : (startY + endY) / 2) - 8;
                      const edgeKey = `${state.id}-${targetId}-${symbol}`;

                      entries.push({ edgeKey, pathD, label: symbol, labelX, labelY });
                    });
                  });

                  // bucket labels by coarse grid so nearby labels are grouped
                  const buckets = new Map<string, number[]>();
                  entries.forEach((e, i) => {
                    const bx = Math.round(e.labelX / 48);
                    const by = Math.round(e.labelY / 28);
                    const key = `${bx}:${by}`;
                    const arr = buckets.get(key) ?? [];
                    arr.push(i);
                    buckets.set(key, arr);
                  });

                  const offsets = new Array<number>(entries.length).fill(0);
                  buckets.forEach((list) => {
                    if (list.length <= 1) return;
                    const n = list.length;
                    const gap = 18;
                    for (let i = 0; i < n; i++) {
                      offsets[list[i]] = (i - (n - 1) / 2) * gap;
                    }
                  });

                  return entries.map((e, i) => (
                    <g key={e.edgeKey}>
                      <path className="yapar-transition" d={e.pathD} markerEnd={`url(#${markerId})`} fill="none" />
                      {renderEdgeLabel(e.label, e.labelX, e.labelY + offsets[i], "yapar-transition-label", "middle")}
                    </g>
                  ));
                })()}
              </svg>

              {data.states.map((state) => {
                const center = positions.get(state.id);
                if (!center) {
                  return null;
                }

                const kernelItems = getKernelItems(state);
                const closureItems = getClosureItems(state);
                const isSelected = yaparSelectedStateId === state.id;

                return (
                  <button
                    key={state.id}
                    type="button"
                    className={`yapar-state-card ${state.id === 0 ? "start" : ""} ${isSelected ? "selected" : ""}`}
                    style={{ left: center.x, top: center.y }}
                    onClick={() => {
                      captureYaparDetailScroll();
                      captureYaparScroll();
                      setYaparSelectedStateId(state.id);
                    }}
                    aria-pressed={isSelected}
                    aria-label={`Estado S${state.id}. ${kernelItems.length} ítems de núcleo y ${closureItems.length} de cierre.`}
                  >
                    <div className="yapar-state-card-header">
                      <span className="yapar-state-card-title">Estado S{state.id}</span>
                      <span className="yapar-state-card-badge">{state.items.length} ítems</span>
                    </div>
                    <div className="yapar-state-card-body">
                      <ul className="yapar-state-item-list yapar-state-item-list-compact yapar-state-item-list-kernel">
                        {kernelItems.length > 0 ? (
                          kernelItems.map((item, index) => (
                            <li key={`kernel-${state.id}-${index}`} className="yapar-state-item-entry yapar-state-item-entry-kernel">
                              <code>{item}</code>
                            </li>
                          ))
                        ) : (
                          <li className="yapar-state-empty-mark yapar-state-empty-mark-kernel" aria-hidden="true" />
                        )}
                      </ul>
                      <ul className="yapar-state-item-list yapar-state-item-list-compact yapar-state-item-list-closure">
                        {closureItems.length > 0 ? (
                          closureItems.map((item, index) => (
                            <li key={`closure-${state.id}-${index}`} className="yapar-state-item-entry yapar-state-item-entry-closure">
                              <code>{item}</code>
                            </li>
                          ))
                        ) : (
                          <li className="yapar-state-empty-mark yapar-state-empty-mark-closure" aria-hidden="true" />
                        )}
                      </ul>
                    </div>
                  </button>
                );
              })}
              </div>
            </div>
          </div>
        </div>

        <div className="yapar-items-sidebar card" ref={yaparDetailScrollRef}>
          <div className="yapar-sidebar-topbar">
            <h4 className="card-title">Detalle del estado</h4>
            <div className="yapar-zoom-controls" role="group" aria-label="Control de zoom del autómata" style={{ marginTop: 6 }}>
              <button type="button" className="btn yapar-zoom-btn" onClick={decreaseYaparZoom} aria-label="Reducir zoom" title="Reducir zoom">-</button>
              <span className="yapar-zoom-value" aria-live="polite">{Math.round(yaparZoom * 100)}%</span>
              <button type="button" className="btn yapar-zoom-btn" onClick={increaseYaparZoom} aria-label="Aumentar zoom" title="Aumentar zoom">+</button>
              <button type="button" className="btn yapar-zoom-btn yapar-zoom-reset" onClick={resetYaparZoom} aria-label="Restablecer zoom" title="Restablecer zoom">1:1</button>
            </div>
          </div>
          {selectedState === null ? (
            <p className="hint">Haz clic en un estado para ver su núcleo y cierre.</p>
          ) : (
            <div className="yapar-state-detail">
              <div className="selected-state-title">Estado S{selectedState.id}</div>
              <section className="yapar-detail-section">
                <h5>Núcleo del estado</h5>
                <ul className="yapar-item-list">
                  {getKernelItems(selectedState).length > 0 ? (
                    getKernelItems(selectedState).map((item, index) => (
                      <li key={`detail-kernel-${selectedState.id}-${index}`} className="yapar-item-entry yapar-item-entry-kernel">
                        <code>{item}</code>
                      </li>
                    ))
                  ) : (
                    <li className="hint">Sin núcleo</li>
                  )}
                </ul>
              </section>

              <section className="yapar-detail-section">
                <h5>Cierre del estado</h5>
                <ul className="yapar-item-list">
                  {getClosureItems(selectedState).length > 0 ? (
                    getClosureItems(selectedState).map((item, index) => (
                      <li key={`detail-closure-${selectedState.id}-${index}`} className="yapar-item-entry yapar-item-entry-closure">
                        <code>{item}</code>
                      </li>
                    ))
                  ) : (
                    <li className="hint">Sin cierre</li>
                  )}
                </ul>
              </section>
            </div>
          )}
        </div>
      </div>
    );
  }

  function renderGraphView(): JSX.Element {
    if (!activeResultAction || !activeResultObject) {
      return <div className="graph-empty">Ejecuta una etapa para ver una visualización.</div>;
    }

    if (activeResultAction === "ast") {
      return renderAstGraph(activeResultObject);
    }

    if (activeResultAction === "combinedNfa") {
      return renderDirectConstructionView(activeResultObject);
    }

    if (activeResultAction === "dfa") {
      const panels = buildAutomatonPanels(activeResultAction, activeResultObject, dfaEdgeLabelMode);
      if (panels.length === 0) {
        return <div className="graph-empty">No hay estructura de autómata para renderizar.</div>;
      }
      return <div className="graph-panels">{panels.map((panel) => renderAutomatonSvg(panel))}</div>;
    }

    if (activeResultAction === "yaparAutomaton") {
      const parsed = activeResultObject as YaparAutomatonResult;
      return renderYaparAutomatonView(parsed);
    }

    return <div className="graph-empty">Esta etapa no tiene visualización gráfica todavía.</div>;
  }

  function reprLexeme(lexeme: string): string {
    if (lexeme === "\n") return "\\n";
    if (lexeme === "\t") return "\\t";
    if (lexeme === "\r") return "\\r";
    if (lexeme === " ") return "\\s";
    return lexeme;
  }

  function renderSlrTable(data: YaparTableResult): JSX.Element {
    return (
      <div className="slr-table-container">
        <h4 className="card-title">Tabla de Análisis SLR (ACTION / GOTO)</h4>
        
        {data.productions && data.productions.length > 0 && (
          <div className="follow-sets-section card" style={{ marginBottom: "1.5rem" }}>
            <h4 className="card-title">Gramática Enumerada</h4>
            <div className="follow-grid">
              {data.productions.map((prod, idx) => {
                const parts = prod.split(': ');
                const num = parts[0];
                const rule = parts.slice(1).join(': ');
                return (
                  <div key={idx} className="follow-row">
                    <span className="follow-nt">({num})</span>
                    <span className="follow-values">{rule}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="slr-table-scroll">
          <table className="slr-grid-table">
            <thead>
              <tr>
                <th rowSpan={2} className="header-state">Estado</th>
                <th colSpan={data.action_headers.length} className="header-action">ACTION</th>
                <th colSpan={data.goto_headers.length} className="header-goto">GOTO</th>
              </tr>
              <tr>
                {data.action_headers.map((h) => (
                  <th key={`act-${h}`} className="sub-header-term">{h}</th>
                ))}
                {data.goto_headers.map((h) => (
                  <th key={`goto-${h}`} className="sub-header-nonterm">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={`row-${row.state}`}>
                  <td className="cell-state">S{row.state}</td>
                  {data.action_headers.map((h) => {
                    const action = row.action[h];
                    if (!action) return <td key={`act-${row.state}-${h}`} className="cell-empty">-</td>;
                    const [type, arg] = action;
                    let display = "";
                    let className = "";
                    if (type === "shift") {
                      display = `s${arg}`;
                      className = "cell-shift";
                    } else if (type === "reduce") {
                      display = `r${arg}`;
                      className = "cell-reduce";
                    } else if (type === "accept") {
                      display = "acc";
                      className = "cell-accept";
                    } else if (type === "error") {
                      display = "err";
                      className = "cell-error";
                    }
                    return (
                      <td key={`act-${row.state}-${h}`} className={`cell-action ${className}`} title={`${type} ${arg}`}>
                        {display}
                      </td>
                    );
                  })}
                  {data.goto_headers.map((h) => {
                    const nextState = row.goto[h];
                    if (nextState === undefined) return <td key={`goto-${row.state}-${h}`} className="cell-empty">-</td>;
                    return (
                      <td key={`goto-${row.state}-${h}`} className="cell-goto">
                        {nextState}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {data.follow && Object.keys(data.follow).length > 0 && (
          <div className="follow-sets-section card">
            <h4 className="card-title">Conjuntos FOLLOW</h4>
            <div className="follow-grid">
              {Object.entries(data.follow).map(([nt, list]) => (
                <div key={nt} className="follow-row">
                  <span className="follow-nt">FOLLOW({nt})</span>
                  <span className="follow-values">{`{ ${list.join(", ")} }`}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  function renderParserTrace(data: YaparParseResult): JSX.Element {
    if (data.errors && data.errors.length > 0) {
      return (
        <div className="parser-trace-error card">
          <h4 className="card-title text-error">Errores detectados</h4>
          <ul className="error-list">
            {data.errors.map((err, idx) => (
              <li key={idx} className="error-item">
                {err}
              </li>
            ))}
          </ul>
          {data.tokens && data.tokens.length > 0 && (
            <div className="tokens-section">
              <h5>Tokens leídos por el Lexer:</h5>
              <div className="tokens-compact-grid">
                {data.tokens.map((t, idx) => (
                  <span key={idx} className="token-badge" title={`L${t.line}:C${t.col}`}>
                    <strong>{t.type}</strong>: {reprLexeme(t.lexeme)}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="parser-trace-container">
        <h4 className="card-title text-ok">✓ Análisis Sintáctico Exitoso</h4>
        <div className="trace-summary-chips">
          <span className="status-chip ok">Cadena aceptada</span>
          <span className="status-chip info">{data.trace.length} pasos</span>
          <span className="status-chip info">{data.tokens.length} tokens</span>
        </div>

        <h5 className="section-title">Secuencia de Acciones (Traza Shift/Reduce)</h5>
        <div className="parser-trace-scroll">
          <table className="parser-trace-table">
            <thead>
              <tr>
                <th>Paso</th>
                <th>Pila de Estados</th>
                <th>Pila de Símbolos</th>
                <th>Lookahead (Siguiente Token)</th>
                <th>Acción</th>
              </tr>
            </thead>
            <tbody>
              {data.trace.map((step) => {
                const isAccept = step.action === "accept" || step.action_arg.includes("Accept") || step.action_arg.includes("Aceptar");
                const isShift = step.action === "shift";
                const isReduce = step.action === "reduce";
                const actionClass = isAccept ? "action-accept" : isShift ? "action-shift" : isReduce ? "action-reduce" : "";

                return (
                  <tr key={step.step}>
                    <td className="cell-step">{step.step}</td>
                    <td className="cell-stack">
                      <code>{`[${step.state_stack.join(", ")}]`}</code>
                    </td>
                    <td className="cell-symbols">
                      <code>{`[${step.symbol_stack.join(", ")}]`}</code>
                    </td>
                    <td className="cell-lookahead">
                      <span className="token-name">{step.lookahead.type}</span>
                      {step.lookahead.lexeme && (
                        <span className="token-lexeme">{` (${reprLexeme(step.lookahead.lexeme)})`}</span>
                      )}
                    </td>
                    <td className={`cell-action ${actionClass}`}>
                      {step.action_arg}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  function pushOutput(type: OutputItem["type"], text: string) {
    setOutput((prev) => [...prev, { ts: nowTime(), type, text }]);
  }

  function enrichBridgeErrorMessage(raw: string): string {
    const msg = raw.trim();
    const ruleAtStartError =
      msg.includes("Se esperaba 'rule' en la posición 0") ||
      msg.includes("Se esperaba 'rule' en la posici") ||
      msg.includes("Se esperaba 'rule' en la posicion 0");

    if (ruleAtStartError) {
      return (
        `${msg}. ` +
        "Tip: el archivo .yal seleccionado no parece usar el formato esperado por este parser. " +
        "Prueba con un spec del formato 'rule tokens = ...' (por ejemplo en manual_cases/yal)."
      );
    }

    return msg;
  }

  async function loadDir(path: string) {
    try {
      const nodes = await listEntries(path);
      setTreeMap((prev) => ({ ...prev, [path]: nodes }));
      return nodes;
    } catch (error) {
      pushOutput("error", `No se pudo listar ${path}: ${String(error)}`);
      return null;
    }
  }

  async function openWorkspaceRoot(path: string) {
    const clean = path.trim();
    if (!clean) {
      pushOutput("error", "Ingrese una ruta de directorio.");
      return;
    }

    const nodes = await loadDir(clean);
    if (!nodes) {
      return;
    }

    setWorkspaceRoot(clean);
    setSelectedPath(clean);
    setTreeMap({ [clean]: nodes });
    setExpandedDirs({ [clean]: true });
    pushOutput("ok", `Directorio abierto: ${clean}`);
  }

  async function openWorkspaceRootFromDialog() {
    try {
      const selected = await pickDirectory();
      if (!selected) {
        return;
      }
      await openWorkspaceRoot(selected);
    } catch (error) {
      pushOutput("error", `No se pudo abrir selector de carpeta: ${String(error)}`);
    }
  }

  function isKnownDirectory(path: string): boolean {
    if (!path) {
      return false;
    }
    if (path === workspaceRoot) {
      return true;
    }
    for (const dirEntries of Object.values(treeMap)) {
      const match = dirEntries.find((entry) => entry.path === path);
      if (match?.isDir) {
        return true;
      }
    }
    return false;
  }

  function resolveCreationTargetDir(): string {
    if (!selectedPath) {
      return workspaceRoot;
    }
    if (isKnownDirectory(selectedPath)) {
      return selectedPath;
    }
    return getParentPath(selectedPath) || workspaceRoot;
  }

  async function startInlineCreate(type: "file" | "folder") {
    const targetDir = resolveCreationTargetDir();
    if (!targetDir) {
      pushOutput("error", "No se pudo determinar directorio destino.");
      return;
    }

    if (!treeMap[targetDir]) {
      await loadDir(targetDir);
    }

    setExpandedDirs((prev) => ({ ...prev, [targetDir]: true }));
    setPendingCreate({
      type,
      parentDir: targetDir,
      draftName: type === "file" ? "new_file.txt" : "new_folder",
    });
  }

  async function commitInlineCreate() {
    if (!pendingCreate) {
      return;
    }

    const itemName = pendingCreate.draftName.trim();
    if (!itemName) {
      pushOutput("error", "Ingrese un nombre válido.");
      return;
    }
    if (itemName.includes("\\") || itemName.includes("/")) {
      pushOutput("error", "Use solo el nombre, sin rutas.");
      return;
    }

    const fullPath = joinPath(pendingCreate.parentDir, itemName);

    try {
      if (pendingCreate.type === "folder") {
        await createDirectory(fullPath);
        pushOutput("ok", `Carpeta creada: ${fullPath}`);
      } else {
        await writeTextFile(fullPath, "");
        pushOutput("ok", `Archivo creado: ${fullPath}`);
      }
      await loadDir(pendingCreate.parentDir);
      if (pendingCreate.type === "file") {
        await openFile(fullPath);
      }
      setPendingCreate(null);
    } catch (error) {
      pushOutput("error", `No se pudo crear ${pendingCreate.type}: ${String(error)}`);
    }
  }

  async function refreshExplorerRoot(showMessage = true) {
    if (!workspaceRoot) {
      return;
    }
    await loadDir(workspaceRoot);
    if (showMessage) {
      pushOutput("info", "Explorer recargado.");
    }
  }

  async function toggleDir(path: string) {
    setSelectedPath(path);
    const isOpen = Boolean(expandedDirs[path]);
    if (isOpen) {
      setExpandedDirs((prev) => ({ ...prev, [path]: false }));
      return;
    }
    if (!treeMap[path]) {
      await loadDir(path);
    }
    setExpandedDirs((prev) => ({ ...prev, [path]: true }));
  }

  async function openFile(path: string) {
    if (tabs.some((tab) => tab.path === path)) {
      setActiveTabPath(path);
      return;
    }
    try {
      console.log("[openFile] Opening file:", path);
      const content = await readTextFile(path);
      console.log("[openFile] File content loaded successfully,  length:", content.length);
      const name = path.split(/[/\\]/).pop() || path;
      const tab: OpenTab = { path, name, content, dirty: false };
      setTabs((prev) => [...prev, tab]);
      setActiveTabPath(path);
      if (name.endsWith(".yal")) {
        setYalFilePath(path);
      }
      if (name.endsWith(".yalp") || name.endsWith(".yapar")) {
        setYaparFilePath(path);
      }
      if (name.endsWith(".txt")) {
        setInputFilePath(path);
      }
      pushOutput("ok", `Archivo abierto: ${name}`);
      setIsRunningAction(false);
    } catch (error) {
      console.error("[openFile] Error opening file:", error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      pushOutput("error", `No se pudo abrir archivo ${path}: ${errorMsg}`);
    }
  }

  function closeTab(path: string) {
    setTabs((prev) => {
      const remaining = prev.filter((tab) => tab.path !== path);
      if (activeTabPath === path) {
        setActiveTabPath(remaining[remaining.length - 1]?.path ?? "");
      }
      return remaining;
    });
  }

  function updateActiveTabContent(next: string) {
    if (!activeTab) {
      return;
    }
    setTabs((prev) =>
      prev.map((tab) =>
        tab.path === activeTab.path
          ? {
              ...tab,
              content: next,
              dirty: true,
            }
          : tab
      )
    );
  }

  async function saveActiveTab() {
    if (!activeTab) {
      pushOutput("info", "No hay pestaña activa para guardar.");
      return;
    }
    try {
      await writeTextFile(activeTab.path, activeTab.content);
      setTabs((prev) =>
        prev.map((tab) => (tab.path === activeTab.path ? { ...tab, dirty: false } : tab))
      );
      pushOutput("ok", `Guardado: ${activeTab.path}`);
    } catch (error) {
      pushOutput("error", `Error al guardar ${activeTab.path}: ${String(error)}`);
    }
  }

  async function executeAction(
    action: AnyAction,
    yalPath: string | undefined,
    yalSource: string | undefined,
    yaparPath: string | undefined = undefined,
    yaparSource: string | undefined = undefined
  ): Promise<boolean> {
    const response = await runYalex({
      workspaceRoot,
      action,
      yalPath,
      yalSource,
      yaparPath,
      yaparSource,
      inputPath: (action === "tokenize" || action === "yaparParse") ? inputFilePath : undefined,
      outputPath: action === "generate"
        ? generateOutputPath
        : action === "yaparGenerate"
        ? generateParserOutputPath
        : undefined,
      includeTrace: action === "tokenize" || action === "yaparParse",
      traceLimit: 200,
    });

    const parsed = response as { ok: boolean; result?: unknown; error?: string };
    if (!parsed.ok) {
      pushOutput("error", enrichBridgeErrorMessage(parsed.error || "Error desconocido en backend."));
      return false;
    }

    const formatted = JSON.stringify(parsed.result, null, 2);
    setLatestResult(formatted);
    setActionResults((prev) => ({ ...prev, [action]: formatted }));
    setActionResultObjects((prev) => ({ ...prev, [action]: parsed.result }));
    setActiveResultAction(action);
    setLeftSidebarView("results");
    pushOutput("ok", `${getActionLabel(action)} finalizado correctamente.`);
    return true;
  }

  async function runFullPipeline(): Promise<boolean> {
    if (!workspaceRoot) {
      pushOutput("error", "No hay workspace abierto.");
      return false;
    }

    if (!yalFilePath.trim()) {
      pushOutput("error", "Debe ingresar la ruta del archivo .yal.");
      return false;
    }

    if (!inputFilePath.trim()) {
      pushOutput("error", "Debe ingresar la ruta del archivo .txt de entrada.");
      return false;
    }

    const yalSource = undefined;
    const yalPath = yalFilePath;

    try {
      setActiveWorkflow("yalex");
      setIsRunningAction(true);
      setValidationChecks([]);
      setValidationRunAt("");
      pushOutput("info", "Iniciando ejecución secuencial de todo el pipeline.");

      for (let index = 0; index < FULL_PIPELINE_ACTIONS.length; index++) {
        const nextAction = FULL_PIPELINE_ACTIONS[index];
        pushOutput(
          "info",
          `Paso ${index + 1}/${FULL_PIPELINE_ACTIONS.length}: ejecutando ${getActionLabel(nextAction)}`
        );

        const ok = await executeAction(nextAction, yalPath, yalSource);
        if (!ok) {
          pushOutput("error", `Pipeline detenido en '${getActionLabel(nextAction)}'.`);
          return false;
        }
      }

      pushOutput("ok", "Pipeline completo finalizado correctamente.");
      return true;
    } catch (error) {
      pushOutput("error", `Fallo al ejecutar pipeline completo: ${String(error)}`);
      return false;
    } finally {
      setIsRunningAction(false);
    }
  }

  async function runYaparPipeline(): Promise<boolean> {
    if (!workspaceRoot) {
      pushOutput("error", "No hay workspace abierto.");
      return false;
    }

    if (!yaparFilePath.trim()) {
      pushOutput("error", "Debe ingresar la ruta del archivo .yalp.");
      return false;
    }

    if (!yalFilePath.trim()) {
      pushOutput("error", "Debe ingresar la ruta del archivo .yal del lexer.");
      return false;
    }

    if (!inputFilePath.trim()) {
      pushOutput("error", "Debe ingresar la ruta del archivo .txt de entrada.");
      return false;
    }

    try {
      setActiveWorkflow("yapar");
      setIsRunningAction(true);
      pushOutput("info", "Iniciando ejecución secuencial del pipeline YAPar.");

      for (let index = 0; index < YAPAR_PIPELINE_ACTIONS.length; index++) {
        const nextAction = YAPAR_PIPELINE_ACTIONS[index];
        pushOutput(
          "info",
          `Paso ${index + 1}/${YAPAR_PIPELINE_ACTIONS.length}: ejecutando ${getActionLabel(nextAction)}`
        );

        const ok = await executeAction(
          nextAction,
          yalFilePath,
          undefined,
          yaparFilePath,
          undefined
        );
        if (!ok) {
          pushOutput("error", `Pipeline YAPar detenido en '${getActionLabel(nextAction)}'.`);
          return false;
        }
      }

      pushOutput("ok", "Pipeline YAPar completo finalizado correctamente.");
      return true;
    } catch (error) {
      pushOutput("error", `Fallo al ejecutar pipeline YAPar completo: ${String(error)}`);
      return false;
    } finally {
      setIsRunningAction(false);
    }
  }

  function renderTree(path: string, depth: number) {
    const children = treeMap[path] || [];
    const rows: Array<JSX.Element> = [];

    if (pendingCreate?.parentDir === path) {
      rows.push(
        <div
          key={`pending-${path}`}
          className="entry entry-create"
          style={{ paddingLeft: `${10 + depth * 14}px` }}
        >
          <span className="entry-kind">{pendingCreate.type === "folder" ? "DIR" : "FILE"}</span>
          <input
            className="entry-create-input"
            value={pendingCreate.draftName}
            autoFocus
            onChange={(event) =>
              setPendingCreate((prev) =>
                prev
                  ? {
                      ...prev,
                      draftName: event.target.value,
                    }
                  : prev
              )
            }
            onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
              if (event.key === "Enter") {
                void commitInlineCreate();
              }
              if (event.key === "Escape") {
                setPendingCreate(null);
              }
            }}
            onBlur={() => setPendingCreate(null)}
          />
        </div>
      );
    }

    children.forEach((entry) => {
      const isOpen = Boolean(expandedDirs[entry.path]);
      const isSelected = selectedPath === entry.path;
      if (entry.isDir) {
        rows.push(
          <div key={entry.path}>
            <button
              className={`entry ${isSelected ? "selected" : ""}`}
              style={{ paddingLeft: `${10 + depth * 14}px` }}
              onClick={() => void toggleDir(entry.path)}
            >
              <span className="entry-kind">{isOpen ? "▾" : "▸"}</span>
              <span>{entry.name}</span>
            </button>
            {isOpen && <div>{renderTree(entry.path, depth + 1)}</div>}
          </div>
        );
        return;
      }

      rows.push(
        <button
          key={entry.path}
          className={`entry ${isSelected ? "selected" : ""}`}
          style={{ paddingLeft: `${10 + depth * 14}px` }}
          onClick={() => {
            setSelectedPath(entry.path);
            if (isTextFile(entry.name)) {
              void openFile(entry.path);
            }
          }}
        >
          <span className="entry-kind">•</span>
          <span>{entry.name}</span>
        </button>
      );
    });

    return rows;
  }

  const didBootstrapRef = useRef<boolean>(false);

  useEffect(() => {
    if (didBootstrapRef.current) {
      return;
    }
    didBootstrapRef.current = true;

    async function bootstrap() {
      const safetyTimeout = setTimeout(() => {
        console.warn("[Bootstrap] Safety timeout reached — forcing isInitializing=false");
        setIsInitializing(false);
        setInitError("Timeout de inicialización: Tauri tardó demasiado en responder.");
      }, 20000);

      try {
        console.log("[Bootstrap] Starting initialization...");

        let tauriReady = false;
        for (let i = 0; i < 12; i++) {
          if (isTauriRuntime()) {
            tauriReady = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }

        if (!tauriReady) {
          throw new Error(
            "Tauri runtime no detectado después de 3s. Asegúrate de correr con `npm run tauri -- dev`."
          );
        }

        console.log("[Bootstrap] Tauri detected, calling getWorkspaceRoot...");

        const root = await getWorkspaceRoot();
        console.log("[Bootstrap] Got workspace root:", root);

        setYalFilePath("");
        setYaparFilePath("");
        setInputFilePath("");
        setGenerateOutputPath(joinPath(root, "output", "lexer_generated_tauri.py"));
        setGenerateParserOutputPath(joinPath(root, "output", "parser_generated_tauri.py"));

        console.log("[Bootstrap] Opening workspace root...");
        const parentRoot = getParentPath(root) || root;
        await openWorkspaceRoot(parentRoot);
        console.log("[Bootstrap] Workspace root opened successfully");
        setInitError(""); // Clear any errors
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error("[Bootstrap] Initialization failed:", error);
        setInitError(errorMsg);
        pushOutput("error", `No se pudo inicializar la app: ${errorMsg}`);
      } finally {
        clearTimeout(safetyTimeout);
        setIsInitializing(false);
      }
    }
    void bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!resizeState) {
      return;
    }

    const activeResize = resizeState;

    function onMouseMove(event: globalThis.MouseEvent) {
      const dx = event.clientX - activeResize.startX;
      const dy = event.clientY - activeResize.startY;

      if (activeResize.target === "sidebar") {
        const nextWidth = Math.min(560, Math.max(260, activeResize.startSidebarWidth + dx));
        setSidebarWidth(nextWidth);
        return;
      }

      if (activeResize.target === "rightPanel") {
        const hostWidth = workbenchSplitRef.current?.clientWidth ?? window.innerWidth;
        const minRightPanelWidth = 260;
        const minEditorWidth = 320;
        const splitterWidth = 6;
        const maxRightPanelWidth = Math.max(
          minRightPanelWidth,
          hostWidth - splitterWidth - minEditorWidth
        );
        const nextWidth = clamp(
          activeResize.startRightPanelWidth - dx,
          minRightPanelWidth,
          maxRightPanelWidth
        );
        setRightPanelWidth(nextWidth);
        return;
      }

      if (activeResize.target === "resultPanel") {
        const nextHeight = Math.min(500, Math.max(160, activeResize.startResultPanelHeight - dy));
        setResultPanelHeight(nextHeight);
        return;
      }

      if (activeResize.target === "outputPanel") {
        const nextHeight = Math.min(440, Math.max(120, activeResize.startOutputPanelHeight - dy));
        setOutputPanelHeight(nextHeight);
      }
    }

    function onMouseUp() {
      setResizeState(null);
    }

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor =
      activeResize.target === "sidebar" || activeResize.target === "rightPanel"
        ? "col-resize"
        : "row-resize";
    document.body.style.userSelect = "none";

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [resizeState]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const payload: PanelSizes = {
      sidebarWidth,
      rightPanelWidth,
      resultPanelHeight,
      outputPanelHeight,
    };

    window.localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify(payload));
  }, [sidebarWidth, rightPanelWidth, resultPanelHeight, outputPanelHeight]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        void saveActiveTab();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTab, tabs]);

  // Auto-scroll output log to bottom only if user is already at the bottom
  useEffect(() => {
    if (!outputLogRef.current) return;

    const container = outputLogRef.current;
    // Always scroll to the bottom after new content is added
    // This is checked immediately, then again after a small delay
    const scrollToBottom = () => {
      container.scrollTop = container.scrollHeight;
    };

    scrollToBottom();
    const timeout = setTimeout(scrollToBottom, 50);
    return () => clearTimeout(timeout);
  }, [output]);

  const pipelineStatus = isRunningAction ? "running" : "idle";
  const pipelineStatusLabel = isRunningAction ? "Procesando" : "Listo";
  const explorerItemCount = workspaceRoot ? Object.values(treeMap).flat().length : 0;

  function ResultPanel({ full }: { full?: boolean }) {
    return (
      <section className={full ? "result-panel result-panel-full" : "result-panel sidepanel-results"}>
        <div className="result-header">
          <div className="result-header-top">
            <div className="panel-title panel-title-tight">Resultado</div>
            <span className="result-state">
              {activeResultAction ? getActionLabel(activeResultAction) : "Sin etapa seleccionada"}
            </span>
          </div>
          {visibleResultActions.length > 0 && (
            <div className="result-tabs" role="tablist" aria-label="Etapas del pipeline">
              {visibleResultActions.map((action) => {
                const isActive = action === activeResultAction;
                return (
                  <button
                    key={action}
                    role="tab"
                    type="button"
                    className={`result-tab-btn ${isActive ? "active" : ""}`}
                    aria-selected={isActive}
                    onClick={() => setActiveResultAction(action)}
                  >
                    {getActionLabel(action)}
                  </button>
                );
              })}
            </div>
          )}
          <div className="result-view-toggle">
            <button
              type="button"
              className={`result-view-btn ${resultViewMode === "json" ? "active" : ""}`}
              onClick={() => setResultViewMode("json")}
            >
              JSON
            </button>
            <button
              type="button"
              className={`result-view-btn ${resultViewMode === "graph" ? "active" : ""}`}
              onClick={() => setResultViewMode("graph")}
              disabled={!canRenderGraph}
            >
              Gráfico
            </button>
            <button
              type="button"
              className={`result-view-btn ${resultViewMode === "code" ? "active" : ""}`}
              onClick={() => setResultViewMode("code")}
              disabled={!canRenderCode}
            >
              Código Python
            </button>
            {resultViewMode === "graph" && activeResultAction === "dfa" && (
              <>
                <button
                  type="button"
                  className={`result-view-btn ${dfaLabelDensity === "compact" ? "active" : ""}`}
                  onClick={() => setDfaLabelDensity("compact")}
                >
                  Compacto
                </button>
                <button
                  type="button"
                  className={`result-view-btn ${dfaLabelDensity === "detailed" ? "active" : ""}`}
                  onClick={() => setDfaLabelDensity("detailed")}
                >
                  Detallado
                </button>
                <button
                  type="button"
                  className={`result-view-btn ${dfaEdgeLabelMode === "ranges" ? "active" : ""}`}
                  onClick={() => setDfaEdgeLabelMode("ranges")}
                >
                  Rangos
                </button>
                <button
                  type="button"
                  className={`result-view-btn ${dfaEdgeLabelMode === "aliases" ? "active" : ""}`}
                  onClick={() => setDfaEdgeLabelMode("aliases")}
                >
                  Alias
                </button>
              </>
            )}
          </div>
        </div>
        {resultViewMode === "graph" && canRenderGraph ? (
          <div className="result-graph-view">{renderGraphView()}</div>
        ) : resultViewMode === "code" && canRenderCode ? (
          <pre className="result-view">
            {isLoadingGeneratedCode ? "Cargando código generado..." : generatedPythonCode}
          </pre>
        ) : activeResultAction === "yaparTable" && activeResultObject ? (
          renderSlrTable(activeResultObject as YaparTableResult)
        ) : activeResultAction === "yaparParse" && activeResultObject ? (
          renderParserTrace(activeResultObject as YaparParseResult)
        ) : (
          <pre className="result-view">{activeResultText}</pre>
        )}
      </section>
    );
  }

  return (
    <>
      {isInitializing && (
        <div className="initializing-overlay">
          <div className="init-content">
            <h2>Inicializando YALex Studio...</h2>
            {initError && (
              <div className="init-error">
                <p><strong>Error:</strong></p>
                <p>{initError}</p>
              </div>
            )}
          </div>
        </div>
      )}
    <div
      className={`shell ${isOutputVisible ? "" : "shell-output-hidden"}`}
      style={{ ['--output-panel-height' as any]: `${effectiveOutputPanelHeight}px` }}
    >
      <header className="topbar">
        <div className="topbar-brand">
          <h1>YALex Studio</h1>
          <span className="topbar-subtitle">Editor + Pipeline</span>
        </div>
        <div className="topbar-right">
          <span className={`status-chip ${pipelineStatus}`}>
            {pipelineStatusLabel}
          </span>
          <div className="topbar-actions">
            <button
              className="topbar-action-btn btn"
              type="button"
              onClick={() => void runFullPipeline()}
              disabled={!canRunFullPipeline}
              aria-disabled={!canRunFullPipeline}
              title={canRunFullPipeline ? "Ejecutar pipeline YALex" : "Carga .yal e input para ejecutar el pipeline YALex"}
            >
              Pipeline YALex
            </button>
            <button
              className="topbar-action-btn btn"
              type="button"
              onClick={() => void runYaparPipeline()}
              disabled={!canRunYaparPipeline}
              aria-disabled={!canRunYaparPipeline}
              title={canRunYaparPipeline ? "Ejecutar pipeline YAPar" : "Carga .yal, .yalp e input para ejecutar el pipeline YAPar"}
            >
              Pipeline YAPar
            </button>
            <button
              className="topbar-action-btn btn"
              type="button"
              onClick={() => void saveActiveTab()}
            >
              <span
                className="panel-icon topbar-icon"
                style={{
                  WebkitMaskImage: `url(${saveIcon})`,
                  maskImage: `url(${saveIcon})`,
                }}
              />
              Guardar
            </button>
            <button
              className="topbar-action-btn btn"
              type="button"
              onClick={() => {
                captureYaparScroll();
                setIsOutputVisible((current) => !current);
              }}
              aria-controls="output-panel"
              aria-expanded={isOutputVisible}
              aria-label={isOutputVisible ? "Ocultar output" : "Mostrar output"}
              title={isOutputVisible ? "Ocultar output" : "Mostrar output"}
            >
              {isOutputVisible ? "Ocultar output" : "Mostrar output"}
            </button>
            
          </div>
        </div>
      </header>

      <main
        className="workspace"
        style={{
          gridTemplateColumns: `${activityBarWidth}px ${leftSidebarView === "results" ? 0 : sidebarWidth}px ${leftSidebarView === "results" ? 0 : 6}px 1fr`,
        }}
      >
        <nav className="activity-bar" aria-label="Navegación lateral">
            <button
            type="button"
            className={`activity-btn ${leftSidebarView === "explorer" ? "active" : ""}`}
            onClick={() => {
              captureYaparScroll();
              setLeftSidebarView("explorer");
            }}
            title="Explorer"
            aria-label="Explorer"
          >
            <span
              className="activity-icon"
              aria-hidden="true"
              style={{ WebkitMaskImage: `url(/icons/explorer.svg)`, maskImage: `url(/icons/explorer.svg)` }}
            />
          </button>
          <button
            type="button"
            className={`activity-btn ${leftSidebarView === "pipeline" ? "active" : ""}`}
            onClick={() => {
              captureYaparScroll();
              setLeftSidebarView("pipeline");
            }}
            title="Pipeline"
            aria-label="Pipeline"
          >
            <span
              className="activity-icon"
              aria-hidden="true"
              style={{ WebkitMaskImage: `url(/icons/pipeline.svg)`, maskImage: `url(/icons/pipeline.svg)` }}
            />
          </button>
          <button
            type="button"
            className={`activity-btn ${leftSidebarView === "results" ? "active" : ""}`}
            onClick={() => {
              captureYaparScroll();
              setLeftSidebarView("results");
            }}
            title="Resultados"
            aria-label="Resultados"
          >
            <span
              className="activity-icon"
              aria-hidden="true"
              style={{ WebkitMaskImage: `url(/icons/results.svg)`, maskImage: `url(/icons/results.svg)` }}
            />
          </button>
        </nav>

        <aside className="sidepanel">
          {leftSidebarView === "explorer" && (
            <div className="explorer-view">
              <div className="panel-title">
                <span>Explorer</span>
                <div className="panel-title-actions">
                  <button
                    title="Abrir carpeta"
                    aria-label="Abrir carpeta"
                    onClick={() => void openWorkspaceRootFromDialog()}
                  >
                    ≡
                  </button>
                  <button
                    title="Refrescar"
                    aria-label="Refrescar"
                    onClick={() => void refreshExplorerRoot()}
                  >
                    ↻
                  </button>
                  <button
                    title="Nuevo archivo"
                    aria-label="Nuevo archivo"
                    onClick={() => void startInlineCreate("file")}
                  >
                    <span
                      className="panel-icon"
                      style={{
                        WebkitMaskImage: `url(${filePlusIcon})`,
                        maskImage: `url(${filePlusIcon})`,
                      }}
                    />
                  </button>
                  <button
                    title="Nueva carpeta"
                    aria-label="Nueva carpeta"
                    onClick={() => void startInlineCreate("folder")}
                  >
                    <span
                      className="panel-icon"
                      style={{
                        WebkitMaskImage: `url(${folderPlusIcon})`,
                        maskImage: `url(${folderPlusIcon})`,
                      }}
                    />
                  </button>
                </div>
              </div>
              <div className="path-row" title={workspaceRoot}>
                <span className="path-row-name">{getPathBaseName(workspaceRoot)}</span>
              </div>
              <div className="file-list">
                {workspaceRoot && renderTree(workspaceRoot, 0)}
              </div>
            </div>
          )}

          {leftSidebarView === "pipeline" && (
            <div className="command-panel">
              <div className="workflow-selector-tab">
                <button
                  type="button"
                  className={`workflow-btn ${activeWorkflow === "yalex" ? "active" : ""}`}
                  onClick={() => setActiveWorkflow("yalex")}
                >
                  YALex (Lexer)
                </button>
                <button
                  type="button"
                  className={`workflow-btn ${activeWorkflow === "yapar" ? "active" : ""}`}
                  onClick={() => setActiveWorkflow("yapar")}
                >
                  YAPar (Parser)
                </button>
              </div>

              {activeWorkflow === "yalex" ? (
                <div className="panel-title panel-title-tight">
                  <span>Pipeline YALex</span>
                  <span className={`status-chip ${pipelineStatus}`}>{pipelineStatusLabel}</span>
                </div>
              ) : (
                <div className="panel-title panel-title-tight">
                  <span>Pipeline YAPar</span>
                  <span className={`status-chip ${pipelineStatus}`}>{pipelineStatusLabel}</span>
                </div>
              )}

              <div className="command-scroll">
                {activeWorkflow === "yalex" ? (
                  <>
                    <section className="command-section">
                      <h3 className="section-title">Archivos de trabajo</h3>

                      <label className="field">
                        <span className="field-label">Archivo .yal</span>
                        <input
                          value={yalFilePath}
                          onChange={(event) => setYalFilePath(event.target.value)}
                          placeholder="Ruta al archivo .yal"
                        />
                      </label>

                      <label className="field">
                        <span className="field-label">Input (.txt)</span>
                        <input
                          value={inputFilePath}
                          onChange={(event) => setInputFilePath(event.target.value)}
                          placeholder="Ruta del texto de entrada"
                        />
                      </label>

                      <label className="field">
                        <span className="field-label">Output lexer</span>
                        <input
                          value={generateOutputPath}
                          onChange={(event) => setGenerateOutputPath(event.target.value)}
                          placeholder="Ruta del lexer generado"
                        />
                      </label>
                    </section>

                    <section className="command-section">
                      <h3 className="section-title">Acciones</h3>
                      <div className="command-actions">
                        <button
                          className="run-all-btn btn btn-primary"
                          onClick={() => void runFullPipeline()}
                          disabled={isRunningAction}
                        >
                          {isRunningAction ? "Ejecutando pipeline..." : "Ejecutar pipeline"}
                        </button>

                        <button
                          className="run-check-btn btn"
                          onClick={() => void runGeneratedLexerProgram()}
                          disabled={isRunningAction}
                        >
                          Ejecutar lexer generado
                        </button>
                      </div>

                      <p className="command-hint">
                        Flujo recomendado: Spec → AST → Construcción Directa → DFA → Tokenizar → Generar Lexer.
                      </p>
                    </section>
                  </>
                ) : (
                  <>
                    <section className="command-section">
                      <h3 className="section-title">Archivos de trabajo</h3>

                      <label className="field">
                        <span className="field-label">Archivo .yalp</span>
                        <input
                          value={yaparFilePath}
                          onChange={(event) => setYaparFilePath(event.target.value)}
                          placeholder="Ruta al archivo .yalp"
                        />
                      </label>

                      <label className="field">
                        <span className="field-label">Archivo .yal (Lexer)</span>
                        <input
                          value={yalFilePath}
                          onChange={(event) => setYalFilePath(event.target.value)}
                          placeholder="Ruta al archivo .yal del lexer"
                        />
                      </label>

                      <label className="field">
                        <span className="field-label">Input (.txt)</span>
                        <input
                          value={inputFilePath}
                          onChange={(event) => setInputFilePath(event.target.value)}
                          placeholder="Ruta del texto de entrada"
                        />
                      </label>

                      <label className="field">
                        <span className="field-label">Output parser</span>
                        <input
                          value={generateParserOutputPath}
                          onChange={(event) => setGenerateParserOutputPath(event.target.value)}
                          placeholder="Ruta del parser generado"
                        />
                      </label>
                    </section>

                    <section className="command-section">
                      <h3 className="section-title">Acciones</h3>
                      <div className="command-actions">
                        <button
                          className="run-all-btn btn btn-primary"
                          onClick={() => void runYaparPipeline()}
                          disabled={isRunningAction}
                        >
                          {isRunningAction ? "Ejecutando YAPar..." : "Ejecutar pipeline YAPar"}
                        </button>
                      </div>

                      <p className="command-hint">
                        Flujo recomendado: Especificación → Autómata LR(0) → Tabla SLR → Parsear (Simulación) → Generar Parser.
                      </p>
                    </section>
                  </>
                )}

                {validationChecks.length > 0 && activeWorkflow === "yalex" && (
                  <section className="validation-panel">
                    <div className="validation-header">
                      <strong>{`Validación ${passedChecks}/${totalChecks}`}</strong>
                      <span>{validationRunAt ? `@ ${validationRunAt}` : ""}</span>
                    </div>
                    <div className="validation-list">
                      {validationChecks.map((check) => (
                        <div key={check.id} className={`validation-item ${check.ok ? "ok" : "fail"}`}>
                          <span className="validation-item-title">{check.label}</span>
                          <span className="validation-item-detail">{check.detail}</span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
              </div>
            </div>
          )}

          {leftSidebarView === "results" && <ResultPanel />}
        </aside>

        <div
          className="splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize side panel"
          onMouseDown={(event) => {
            captureYaparScroll();
            setResizeState({
              target: "sidebar",
              startX: event.clientX,
              startY: event.clientY,
              startSidebarWidth: sidebarWidth,
              startRightPanelWidth: rightPanelWidth,
              startResultPanelHeight: resultPanelHeight,
              startOutputPanelHeight: outputPanelHeight,
            });
          }}
        />

        <section
          className={`editor-area editor-area-simple ${leftSidebarView === "results" ? "editor-area-results-mode" : ""}`}
        >
          {leftSidebarView === "results" ? (
            <div className="results-fullwidth-container">
              <ResultPanel full />
            </div>
          ) : (
            <>
              <div className="tabs">
            {tabs.length === 0 ? (
              <span className="tabs-empty">Sin archivos abiertos</span>
            ) : (
              tabs.map((tab) => (
                <button
                  key={tab.path}
                  className={`tab ${tab.path === activeTabPath ? "active" : ""}`}
                  onClick={() => setActiveTabPath(tab.path)}
                >
                  {tab.name}
                  {tab.dirty ? " ●" : ""}
                  <span
                    className="tab-close"
                    onClick={(event) => {
                      event.stopPropagation();
                      closeTab(tab.path);
                    }}
                  >
                    ×
                  </span>
                </button>
              ))
            )}
          </div>

              <div className="editor-shell">
                {activeTab ? (
                  <Editor
                    beforeMount={registerEditorTheme}
                    language={languageFromFileName(activeTab.name)}
                    value={activeTab.content}
                    onChange={(value: string | undefined) => updateActiveTabContent(value ?? "")}
                    theme="yalex-dark"
                    options={{
                      fontSize: 14,
                      fontFamily: "Cascadia Code, Consolas, monospace",
                      minimap: { enabled: false },
                      automaticLayout: true,
                      tabSize: 2,
                      insertSpaces: true,
                      lineNumbers: "on",
                      wordWrap: "on",
                      smoothScrolling: true,
                      scrollBeyondLastLine: false,
                    }}
                  />
                ) : (
                  <div className="editor-empty">
                    <strong>Inicio rápido</strong>
                    <br />
                    1) Ve a Explorer en la barra lateral izquierda y abre un archivo .yal.
                    <br />
                    2) Usa Pipeline para ejecutar el flujo.
                    <br />
                    3) Consulta Resultados y Output para validar.
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </main>

      <div
        className={`splitter splitter-horizontal shell-horizontal-splitter ${isOutputVisible ? "" : "shell-horizontal-splitter-hidden"}`}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize output"
        onMouseDown={(event) =>
          setResizeState({
            target: "outputPanel",
            startX: event.clientX,
            startY: event.clientY,
            startSidebarWidth: sidebarWidth,
            startRightPanelWidth: rightPanelWidth,
            startResultPanelHeight: resultPanelHeight,
            startOutputPanelHeight: outputPanelHeight,
          })
        }
      />

      <section className={`output-panel ${isOutputVisible ? "" : "output-panel-hidden"}`} id="output-panel" aria-hidden={!isOutputVisible}>
        <div className="panel-title output-header">
          <span>Output</span>
          <span className="output-counter">{output.length} eventos</span>
        </div>
        <div className="output-log" ref={outputLogRef}>
          {output.map((line, index) => (
            <div key={`${line.ts}-${index}`} className={`out-line ${line.type}`}>
              [{line.ts}] {line.text}
            </div>
          ))}
        </div>
      </section>
    </div>
    </>
  );
}
