export type FileNode = {
  name: string;
  path: string;
  isDir: boolean;
};

export type OpenTab = {
  path: string;
  name: string;
  content: string;
  dirty: boolean;
};

export type YalexAction =
  | "spec"
  | "ast"
  | "nfa"
  | "combinedNfa"
  | "dfa"
  | "tokenize"
  | "generate"
  | "executeGeneratedLexer";

export type YaparAction =
  | "yaparSpec"
  | "yaparAutomaton"
  | "yaparTable"
  | "yaparGenerate"
  | "yaparParse";

export type AnyAction = YalexAction | YaparAction;

export type YaparSpecResult = {
  tokens: string[];
  start_symbol: string;
  productions: {
    lhs: string;
    rhs: string[];
    action?: string;
  }[];
};

export type YaparState = {
  id: number;
  items: string[];
  kernel_items?: string[];
  closure_items?: string[];
  transitions: Record<string, number>;
};

export type YaparAutomatonResult = {
  states: YaparState[];
  dot: string;
};

export type YaparTableResult = {
  action_headers: string[];
  goto_headers: string[];
  rows: {
    state: number;
    action: Record<string, [string, number | string]>;
    goto: Record<string, number>;
  }[];
  follow: Record<string, string[]>;
};

export type ParserTraceStep = {
  step: number;
  state_stack: number[];
  symbol_stack: string[];
  lookahead: {
    type: string;
    lexeme: string;
    line: number;
    col: number;
  };
  action: string;
  action_arg: string;
};

export type YaparParseResult = {
  success: boolean;
  tokens: {
    type: string;
    lexeme: string;
    line: number;
    col: number;
  }[];
  trace: ParserTraceStep[];
  errors: string[];
};
