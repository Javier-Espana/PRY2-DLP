"""YAPar specification parser.

Parses .yapar files which define context-free grammars in a format similar to Yacc/Bison.
"""
import re
from dataclasses import dataclass
from typing import List, Dict, Optional


@dataclass
class Token:
    name: str
    

@dataclass
class Production:
    """A grammar production rule: LHS -> RHS"""
    lhs: str
    rhs: List[str]  # Symbols on right-hand side
    action: Optional[str] = None  # Semantic action code


@dataclass
class GrammarSpec:
    """Complete grammar specification from .yapar file"""
    tokens: List[str]
    start_symbol: str
    productions: List[Production]
    declarations: Dict[str, str]  # header, trailer, etc.


def _split_top_level(text: str, separator: str) -> List[str]:
    """Split text on a separator only when it is outside braces and quotes."""
    parts: List[str] = []
    current: List[str] = []
    brace_depth = 0
    quote_char: Optional[str] = None
    escaped = False

    for ch in text:
        if quote_char is not None:
            current.append(ch)
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == quote_char:
                quote_char = None
            continue

        if ch in ('"', "'"):
            quote_char = ch
            current.append(ch)
            continue

        if ch == '{':
            brace_depth += 1
        elif ch == '}' and brace_depth > 0:
            brace_depth -= 1

        if ch == separator and brace_depth == 0:
            part = ''.join(current).strip()
            if part:
                parts.append(part)
            current = []
        else:
            current.append(ch)

    tail = ''.join(current).strip()
    if tail:
        parts.append(tail)

    return parts


def parse_yapar(source: str) -> GrammarSpec:
    """Parse a .yapar specification file.
    
    Format:
        %{
            /* C/Python code block (declarations) */
        %}
        
        %token TOKEN1 TOKEN2 ...
        %start symbol_name
        
        %%
        
        nonterminal:
            production1 { action }
            | production2 { action }
            ;
        
        %%
    """
    lines = source.split('\n')
    
    # Extract header block (between %{ ... %})
    header_match = re.search(r'%\{(.*?)%\}', source, re.DOTALL)
    header = header_match.group(1).strip() if header_match else ""
    
    # Extract declarations section
    tokens = []
    start_symbol = ""
    
    # Find %token declarations
    for line in lines:
        if line.strip().startswith('%token'):
            token_line = line.replace('%token', '').strip()
            tokens.extend(token_line.split())
    
    # Find %start declaration
    for line in lines:
        if line.strip().startswith('%start'):
            start_symbol = line.replace('%start', '').strip()
            break
    
    # Extract grammar rules (after %%)
    grammar_section = source.split('%%')[-2] if source.count('%%') >= 2 else ""
    productions = _parse_grammar_rules(grammar_section)
    
    return GrammarSpec(
        tokens=tokens,
        start_symbol=start_symbol or (productions[0].lhs if productions else ""),
        productions=productions,
        declarations={"header": header}
    )


def _parse_grammar_rules(grammar_text: str) -> List[Production]:
    """Parse grammar rules from the grammar section.
    
    Format:
        nonterminal:
            production1 { action }
            | production2 { action }
            ;
        
        other_nt:
            production { action }
            ;
    """
    productions = []
    
    # Remove comments
    grammar_text = re.sub(r'/\*.*?\*/', '', grammar_text, flags=re.DOTALL)
    grammar_text = re.sub(r'//.*?$', '', grammar_text, flags=re.MULTILINE)
    
    # Split by semicolons to get rule groups, but ignore semicolons inside actions.
    rule_groups = _split_top_level(grammar_text, ';')
    
    for group in rule_groups:
        group = group.strip()
        if not group:
            continue
        
        # Find the first colon to identify LHS
        colon_idx = group.find(':')
        if colon_idx == -1:
            continue
        
        # LHS is everything before the colon
        # Need to get just the identifier, not stuff from previous rules
        lhs_part = group[:colon_idx].strip()
        # Take the last token (in case of multi-line)
        lhs_tokens = lhs_part.split()
        if not lhs_tokens:
            continue
        lhs = lhs_tokens[-1]
        
        if not lhs.isidentifier():
            continue
        
        # RHS is everything after the colon
        body = group[colon_idx + 1:].strip()
        
        # Parse productions (alternatives separated by |) without breaking actions.
        alternatives = _split_top_level(body, '|')
        
        for alt in alternatives:
            alt = alt.strip()
            if not alt:
                continue
            
            # Extract action { ... } if present
            action_match = re.search(r'\{([^}]*)\}', alt)
            action = action_match.group(1).strip() if action_match else None
            
            # Remove action to get symbols
            rhs_text = re.sub(r'\{[^}]*\}', '', alt).strip()
            rhs = rhs_text.split() if rhs_text else []
            
            # Allow epsilon production (empty RHS)
            productions.append(Production(lhs=lhs, rhs=rhs, action=action))
    
    return productions
