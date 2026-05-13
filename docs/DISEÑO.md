# Diseño de Software - Generador YALex/YAPar

## 1. Visión General

**YALex Studio** es un software generador de analizadores léxicos (lexers) y sintácticos (parsers) desarrollado sin dependencias externas de expresiones regulares o librerías de autómatas. El proyecto consta de dos fases:

- **Fase 1 (Completada):** Generador de analizadores léxicos (YALex)
- **Fase 2 (En desarrollo):** Generador de analizadores sintácticos (YAPar)

## 2. Arquitectura General

```
PRY2-DLP/
├── src/
│   ├── yalex_generator/         ← Generador de lexers (shim de compatibilidad)
│   ├── yalex_parser/            ← Implementación original del lexer
│   ├── yapar_generator/         ← Generador de parsers LR(0)
│   ├── common/                  ← Utilidades compartidas
│   ├── cli/                     ← Interfaz de línea de comandos
│   ├── bridge_cli.py            ← Bridge para aplicación desktop (lexer)
│   ├── bridge_yapar.py          ← Bridge para YAPar (parser)
│   └── main.py                  ← CLI interactivo del lexer
├── frontend/
│   └── desktop-app/             ← Aplicación Tauri + React IDE
├── examples/
│   ├── low/                     ← Ejemplos de baja complejidad
│   ├── medium/                  ← Ejemplos de complejidad media
│   └── high/                    ← Ejemplos de alta complejidad
├── tests/                       ← Suite de pruebas unitarias
├── docs/                        ← Documentación técnica
└── artifacts/                   ← Salidas generadas (diagramas, lexers)
```

## 3. Módulos Principales

### 3.1 Generador de Lexers (`src/yalex_parser/`)

**Responsabilidad:** Analizar especificaciones YALex y generar analizadores léxicos Python.

**Módulos clave:**
- `parser.py` - Parser de especificaciones `.yal`
- `regex_parser.py` - Parser de expresiones regulares sin librerías
- `regex_ast.py` - Construcción de AST para regex
- `thompson.py` - Construcción de AFN (Thompson)
- `direct.py` - Método directo: construcción AFD (FollowPos)
- `dfa.py` - Minimización de AFD (Hopcroft)
- `simulator.py` - Simulación con traza de transiciones
- `codegen.py` - Generación de código Python del lexer

**Flujo:**
```
Especificación .yal
    ↓
Parser YALex (extrae lets, rules, header, trailer)
    ↓
Análisis de regex (construye AST)
    ↓
Método Directo (calcula nullable, firstpos, lastpos, followpos)
    ↓
Construcción AFD (directa)
    ↓
Minimización AFD (Hopcroft)
    ↓
Tabla de transiciones
    ↓
Generación Python (lexer autónomo)
```

### 3.2 Generador de Parsers (`src/yapar_generator/`)

**Responsabilidad:** Analizar especificaciones YAPar y generar analizadores sintácticos LR(0).

**Módulos clave:**
- `yapar_parser.py` - Parser de especificaciones `.yapar`
- `lr0.py` - Construcción de autómata LR(0) canónico
  - Clase `LR0Item` - Representa un item LR(0)
  - Clase `LR0State` - Conjunto de items
  - Clase `LR0Automaton` - Colección canónica completa
  - Algoritmo de closure y GOTO
- `table.py` - Construcción de tablas SLR (ACTION/GOTO)
  - Computación de conjuntos FOLLOW
  - Generación de tabla de análisis
- `parser.py` - Implementación del parser SLR
  - Máquina de pilas (stack machine)
  - Algoritmo de análisis shift/reduce
- `codegen.py` - Generación de código Python del parser
- `visualizer.py` - Generación de DOT para Graphviz

**Flujo:**
```
Especificación .yapar
    ↓
Parser YAPar (extrae %token, %start, producciones)
    ↓
Construcción LR(0)
    - Crear estado inicial con S' → .S
    - Computar closure y GOTO para cada símbolo
    - BFS para colección canónica
    ↓
Construcción de Tabla SLR
    - Computar conjuntos FOLLOW
    - Generar acciones SHIFT (de GOTO a terminales)
    - Generar acciones REDUCE (de items de reducción)
    - Generar GOTO (GOTO a no-terminales)
    ↓
Generación de Parser Python (tabla comprimida)
    ↓
Parser puede usar tokens del lexer
```

### 3.3 Utilidades Comunes (`src/common/`)

- `Token` - Dataclass para representar tokens

### 3.4 Interfaz de Línea de Comandos (`src/bridge_yapar.py`)

Proporciona acciones para:
- `analyze-yal` - Analizar especificación YALex
- `gen-lexer` - Generar lexer desde .yal
- `analyze-yapar` - Analizar especificación YAPar
- `gen-parser` - Generar parser desde .yapar
- `visualize` - Generar diagrama LR(0) en DOT

## 4. Flujo Lexer + Parser Integrados

```
Archivo .yal + Archivo .yapar + Archivo de entrada
    ↓
[1] Generar Lexer: python src/bridge_yapar.py gen-lexer spec.yal -o lexer.py
    ↓
[2] Generar Parser: python src/bridge_yapar.py gen-parser spec.yapar -o parser.py
    ↓
[3] Ejecutar integrado:
    input.txt → lexer.py → (tokens) → parser.py → (AST o errores)
```

## 5. Especificaciones de Entrada

### 5.1 Formato YALex

```yalex
%{
/* Código de encabezado Python */
%}

DIGIT = [0-9]
ID = [a-zA-Z_][a-zA-Z0-9_]*

%%

{DIGIT}+        { return("NUMBER", lexeme) }
{ID}             { return("ID", lexeme) }
[ \t\n]+         { skip() }

%%
```

### 5.2 Formato YAPar

```yapar
%{
/* Código de encabezado Python */
%}

%token NUMBER ID PLUS MINUS
%start expr

%%

expr
    : term
    | expr PLUS term
    | expr MINUS term
    ;

term
    : NUMBER
    | ID
    ;

%%
```

## 6. Algoritmos Clave

### 6.1 Construcción LR(0)

1. **Creación de producción aumentada:** S' → S
2. **Estado inicial:** Closure({S' → .S})
3. **Colección canónica (BFS):**
   - Para cada estado, agrupar items por símbolo después del punto
   - Calcular GOTO(items, símbolo)
   - Si no existe, crear nuevo estado
   - Agregar transiciones

### 6.2 Algoritmo de Análisis SLR

```
1. Inicializar: stack = [0], valor_stack = []
2. Mientras no sea aceptado:
   a) Leer símbolo de lookahead (token actual)
   b) Obtener acción de tabla[estado_tope][lookahead]
   c) Si SHIFT n: push(n), avanzar token
   d) Si REDUCE p: pop (|RHS|), push(GOTO(estado_nuevo, LHS))
   e) Si ACCEPT: retornar éxito
   f) Si ERROR: reportar error
```

## 7. Generación de Código

### 7.1 Lexer Generado

- Tabla de transiciones comprimida (tuplas de (estado, símbolo) → estado_siguiente)
- Función `tokenize(text, accept_states, transitions_table)`
- Reporting de posición (línea, columna), errores léxicos

### 7.2 Parser Generado

- Tabla ACTION comprimida (estado, lookahead) → (acción, argumento)
- Tabla GOTO comprimida (estado, no-terminal) → estado_siguiente
- Lista de producciones (LHS, RHS)
- Función `parse(token_stream)` que retorna `ParseResult`

## 8. Ejemplos de Uso

### Baja Complejidad
- Especificación: `examples/low/calc_simple.yal` + `.yapar`
- Entrada: expresiones aritméticas simples
- Salida: AST para `a + b * c`

### Complejidad Media
- Especificación: `examples/medium/lang_medium.yal` + `.yapar`
- Entrada: código con if/while/for, declaraciones de variables
- Salida: AST para programas pequeños

### Alta Complejidad
- Especificación: `examples/high/lang_oop.yal` + `.yapar`
- Entrada: código tipo Java con clases, métodos, excepciones
- Salida: AST para programas orientados a objetos

## 9. Testing

- Unit tests en `tests/` cubren:
  - Pipeline completo YALex (parsing, AFD, tokenización, codegen)
  - Casos extremos (deep nesting, unicode, etc.)
  - YAPar (parsing, LR(0), tabla SLR)

## 10. Interfaz de Usuario

### CLI Interactiva (Terminal)
- Menú para seleccionar acciones
- Opciones: ver spec, AST, AFD, tokenizar, generar lexer

### IDE Desktop (Tauri + React)
- Explorer de archivos recursivo
- Editor con resaltado de sintaxis
- Panel de ejecución de acciones
- Resultado JSON y traza de análisis
- Paneles redimensionables

## 11. Dependencias

### Runtime
- Python 3.10+
- Sin dependencias externas (PEP 517 compatible)

### Frontend (opcional)
- Node.js 18+
- Tauri (interfaz desktop)
- React + Monaco Editor
- Vite (build)

## 12. Restricciones y Decisiones de Diseño

1. **Sin librerías de regex:** Se implementan autómatas finitos directamente
2. **Parser LR(0) simplificado:** SLR sin resolver conflictos avanzados (LALR)
3. **Python 3 como target:** Todos los generadores producen código Python
4. **Formato Yacc/Bison compatible:** Especificaciones similares a herramientas estándar
5. **Generadores autónomos:** Lexer y parser generados no dependen del generador

## 13. Limitaciones Conocidas

- LR(0) puede tener conflictos en gramáticas complejas
- No se detectan ni resuelven conflictos shift/reduce
- Acciones semánticas son placeholders (código sin ejecutar)
- FIRST sets no se computan completamente

## 14. Futuro

- Implementar LALR(1) para mejor manejo de conflictos
- Añadir semantic actions reales
- Optimizar tablas (comprimir filas duplicadas)
- Soportar más formatos de salida (C, Java, JavaScript)
- Herramientas de debugging del automaton
