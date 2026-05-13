# Quick Start Guide - YALex Studio

## 1. Verificar que todo funciona

```bash
cd /home/javier-espana/Escritorio/PRY2-DLP
python3 -m unittest discover -s tests -p "test_*.py" -v
```

Resultado esperado: ✅ **18 tests PASANDO** en 0.6 segundos

## 2. Análisis de especificaciones YAPar

### Ver especificación parseada

```bash
python3 src/bridge_yapar.py analyze-yapar examples/low/calc_simple.yapar
```

Salida:
```
=== YAPar Specification ===
Start symbol: expr
Tokens: ['NUMBER', 'ID', 'PLUS', 'MINUS', 'TIMES', 'DIV', 'LPAREN', 'RPAREN']
Productions: [
  0. expr → term
  1. expr → expr PLUS term
  2. expr → expr MINUS term
  3. expr → expr TIMES term
  4. expr → expr DIV term
  5. term → NUMBER
  6. term → ID
  7. term → LPAREN expr RPAREN
]
```

## 3. Generar Parser Autónomo

### Generar del lexer

```bash
python3 src/bridge_yapar.py gen-lexer examples/low/calc_simple.yal -o artifacts/lexer_calc.py
```

Genera: `artifacts/lexer_calc.py` (lexer autónomo, sin dependencias)

### Generar parser

```bash
python3 src/bridge_yapar.py gen-parser examples/low/calc_simple.yapar -o artifacts/parser_calc.py
```

Genera: `artifacts/parser_calc.py` (parser autónomo SLR, sin dependencias)

## 4. Visualizar Autómata LR(0)

```bash
python3 src/bridge_yapar.py visualize examples/low/calc_simple.yapar -o artifacts/lr0_calc.dot
```

Genera: `artifacts/lr0_calc.dot` (formato Graphviz)

Convertir a PNG (si tienes Graphviz instalado):
```bash
dot -Tpng artifacts/lr0_calc.dot -o artifacts/lr0_calc.png
```

## 5. Usar Generador y Parser Generado

```python
# archivo: test_generated.py
import sys
sys.path.insert(0, 'artifacts')

from lexer_calc import tokenize  # lexer generado
from parser_calc import parse    # parser generado

# Entrada
input_text = "3 + 5 * 2"

# Tokenizar
tokens = tokenize(input_text)

# Parsear
result = parse(tokens)

if result['success']:
    print("✓ Parse successful!")
    print("AST:", result['ast'])
else:
    print("✗ Parse failed!")
    print("Errors:", result['errors'])
```

Ejecutar:
```bash
python3 test_generated.py
```

## 6. Niveles de Complejidad

### Baja Complejidad (Calculadora)
```bash
cd /home/javier-espana/Escritorio/PRY2-DLP/examples/low
cat input.txt          # Ver entrada
cat calc_simple.yal    # Ver lexer spec
cat calc_simple.yapar  # Ver parser spec
```

### Complejidad Media (Lenguaje con Control de Flujo)
```bash
cd /home/javier-espana/Escritorio/PRY2-DLP/examples/medium
cat input.txt          # Código con if/while/for
cat lang_medium.yal    # Lexer con keywords
cat lang_medium.yapar  # Parser con statements
```

### Alta Complejidad (OOP)
```bash
cd /home/javier-espana/Escritorio/PRY2-DLP/examples/high
cat input.txt          # Código tipo Java
cat lang_oop.yal       # Lexer para OOP
cat lang_oop.yapar     # Parser para clases/interfaces
```

## 7. Casos de Uso

### Usar solo el Lexer

```python
from yalex_parser import parser as yalex_parser

spec_text = open("examples/low/calc_simple.yal").read()
result = yalex_parser.parse(spec_text)

print("Tokens:", result['spec'].tokens)
print("Reglas:", len(result['spec'].rules))

# Usar el lexer directamente
from artifacts.lexer_calc import tokenize
tokens = tokenize("3 + 5")
```

### Usar solo el Parser

```python
from yapar_generator import parse_yapar, build_lr0_automaton

spec_text = open("examples/low/calc_simple.yapar").read()
grammar = parse_yapar(spec_text)

# Construir automata LR(0)
automaton = build_lr0_automaton(grammar)
print(f"Estados LR(0): {len(automaton.states)}")
```

### Visualizar Autómata

```python
from yapar_generator import render_automaton_dot

dot_content = render_automaton_dot(automaton)
with open("output.dot", "w") as f:
    f.write(dot_content)

# Convertir con: dot -Tpng output.dot -o output.png
```

## 8. Comandos CLI Disponibles

```bash
python3 src/bridge_yapar.py --help
```

Comandos:
- `analyze-yal FILE` - Mostrar especificación YALex parseada
- `gen-lexer FILE -o OUTPUT` - Generar lexer Python
- `analyze-yapar FILE` - Mostrar especificación YAPar parseada
- `gen-parser FILE -o OUTPUT` - Generar parser Python SLR
- `visualize FILE -o OUTPUT` - Generar visualización DOT del autómata

## 9. Documentación Completa

- **[docs/DISEÑO.md](../docs/DISEÑO.md)** - Arquitectura del software
- **[README.md](../README.md)** - Descripción general del proyecto
- **[YALex.md](../YALex.md)** - Documentación del método directo

## 10. Troubleshooting

### Error: "No module named 'yapar_generator'"
```bash
# Asegurar que estás en la raíz del proyecto
cd /home/javier-espana/Escritorio/PRY2-DLP
export PYTHONPATH=/home/javier-espana/Escritorio/PRY2-DLP/src:$PYTHONPATH
python3 src/bridge_yapar.py analyze-yapar examples/low/calc_simple.yapar
```

### Error: "Syntax error in .yapar file"
Verificar:
1. Declaraciones `%token` obligatorias
2. `%%` delimitadores correctos
3. Producciones terminan con `;`
4. Alternativas separadas con `|`

### Tests fallando
```bash
# Ejecutar con verbose
python3 -m unittest tests.test_yapar_generator -v

# Ejecutar test específico
python3 -m unittest tests.test_yapar_generator.TestYAParParser.test_parse_simple_grammar -v
```

## 11. Próximos Pasos

- [ ] Generar parsers para ejemplos medium/high
- [ ] Implementar acciones semánticas reales
- [ ] Crear flujo integrado en aplicación desktop
- [ ] Optimizar tablas de análisis
- [ ] Agregar herramientas de debugging

---

**Última actualización:** 2024 - Proyecto en estado funcional con 18/18 tests pasando
