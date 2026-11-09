# Resultados de prueba A/B: Plugin `token-saver` para OpenCode V2

Este documento resume una prueba comparativa real entre sesiones de OpenCode con y sin el plugin `token-saver`, traduciendo un archivo de Python a Rust.

---

## Configuración de la prueba

| Aspecto | Sesión SIN plugin | Sesión CON plugin |
|---|---|---|
| **Tarea** | Traducir `calculador_tokens.py` a Rust | Traducir `calculador_tokens_copia.py` a Rust |
| **Archivo origen** | `/home/dan/Pictures/calculador_tokens.py` | `/home/dan/Pictures/calculador_tokens_copia.py` |
| **Archivo destino** | `calculador_tokens.rs` | `calculador_tokens_copia.rs` |
| **Contenido origen** | Idéntico (2836 bytes, 74 líneas) | Idéntico (2836 bytes, 74 líneas) |
| **Session ID** | `ses-rust-sin-plugin` | `ses-rust-con-plugin` |
| **Modelo** | `beam-free` | `beam-free` |

Ambos archivos de Python contenían exactamente el mismo código. La única diferencia era la ruta del archivo objetivo (original vs copia), para que ambas sesiones trabajaran de forma independiente pero sobre contenido equivalente.

---

## Tabla comparativa de consumo de tokens

| Métrica | SIN plugin | CON plugin | Diferencia | Ahorro % |
|---|---|---|---|---|
| **Input tokens** | 30,920 | 13,932 | −16,988 | **54.9%** |
| **Output tokens** | 3,304 | 2,026 | −1,278 | **38.7%** |
| **Total tokens** | 34,224 | 15,958 | −18,266 | **53.4%** |
| **Mensajes** | 31 | 12 | −19 | — |

---

## ¿Por qué el plugin ahorra más del 50%?

### 1. Deduplicación de lecturas (`dedupeReads`)

Antes de permitir un `read`, el plugin verifica con `stat()` (mtime + size, sin leer contenido) si el archivo ya fue leído en la sesión actual y no ha cambiado. Si es así, bloquea la relectura y el modelo recibe un mensaje corto en lugar de volver a pagar por todo el archivo.

En la sesión SIN plugin, el modelo leyó el archivo Python múltiples veces durante el proceso de traducción. En la sesión CON plugin, las lecturas repetidas se bloquearon después de la primera.

### 2. Trim seguro de whitespace (`trimWhitespace`)

Antes de ejecutar `write` o `edit`, el plugin recorta espacios/tabs al final de cada línea y colapsa 3+ líneas vacías consecutivas a una sola, sin tocar la indentación inicial (que es semántica). Esto reduce los bytes que el modelo escribe sin cambiar la lógica del código.

### 3. Menos mensajes de ida y vuelta

La sesión SIN plugin requirió 31 mensajes vs 12 en la sesión CON plugin. El plugin ayuda al modelo a ser más directo en sus operaciones de archivo.

### 4. Formato real post-edit (`formatOnEdit`)

Después de cada `write`/`edit` exitoso, el plugin ejecuta un formatter externo (Prettier, Black, gofmt...) vía Bun Shell. El modelo escribe su mejor intento y el formatter deja el archivo prolijo, sin que el modelo tenga que regenerar bloques enteros por una sangría mal puesta.

---

## Archivos generados

| Sesión | Archivo Rust generado | Origen |
|---|---|---|
| SIN plugin | `/home/dan/Pictures/calculador_tokens.rs` | `/home/dan/Pictures/calculador_tokens.py` |
| CON plugin | `/home/dan/Pictures/calculador_tokens_copia.rs` | `/home/dan/Pictures/calculador_tokens_copia.py` |

Ambos archivos Rust contienen la misma lógica (`estimar_tokens`, `main`, `sumar_dos_numeros`) y producen salida idéntica al script Python original (verificado con diff de stdout).

---

## Sesiones completas en Markdown

### Sesión SIN plugin

Véase [`sesion-rust-sin-plugin.md`](./sesion-rust-sin-plugin.md) — 31 mensajes, 34,224 tokens totales.

### Sesión CON plugin

Véase [`sesion-rust-con-plugin.md`](./sesion-rust-con-plugin.md) — 12 mensajes, 15,958 tokens totales.

---

## Conclusión

En una tarea real de traducción de código (Python → Rust), el plugin `token-saver` redujo el consumo de tokens en **53.4%** en comparación con una sesión equivalente sin el plugin.

El ahorro se distribuye así:
- **Input tokens:** −54.9% (menos re-lecturas de archivos)
- **Output tokens:** −38.7% (menos regeneración de código por problemas de formato)

El plugin cumple su objetivo de reducir el consumo de tokens en sesiones de programación asistida por IA, sin cambiar lo que el modelo puede hacer ni comprometer la calidad del código generado.

---

## Cómo reproducir

1. Clona el repositorio:
   ```bash
   git clone https://github.com/kikeh2/opencode-token-saver.git ~/.config/opencode/plugin/token-saver
   ```

2. Crea un archivo de prueba (o usa uno existente).

3. Ejecuta OpenCode con y sin el plugin activo, pidiendo la misma tarea de modificación/creación de archivo.

4. Compara el consumo de tokens en las exportaciones de sesión.

---

*Prueba realizada con OpenCode V2, modelo `beam-free`, 9 de noviembre de 2026.*
