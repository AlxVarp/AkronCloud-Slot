# Inventario de capacidades Codex — AkronCloud Slot

Actualizado: 2026-07-29.

Este documento separa las capacidades **disponibles** en esta sesión de las
que se **usaron realmente** para construir, probar y desplegar la API MT5.
Una *skill* define un flujo de trabajo; un *plugin* puede aportar skills,
herramientas y conectores; un servidor MCP expone datos o acciones de otro
sistema. No son sinónimos.

## Usadas en este proyecto

| Capacidad | Tipo | Uso concreto |
| --- | --- | --- |
| `ponytail` | Skill | Mantener los cambios mínimos, reutilizar el código existente y evitar dependencias innecesarias. |
| `mmx-cli` | Skill + CLI MiniMax | Revisión de planes de prueba y riesgos del benchmark. No recibió contraseñas, tokens ni datos sensibles. |
| `openai-docs` | Skill | Consultar la guía vigente de Codex antes de documentar capacidades, skills y MCP. |
| PowerShell / shell | Herramienta local | Git, TypeScript, Docker remoto, SSH y comprobaciones de estado. |
| `apply_patch` | Herramienta local | Cambios de código y documentación, incluidos los artefactos de benchmark. |
| Git / GitHub remoto | Integración por CLI | Commits, push de `codex/p0-trading` y tag `v0.4.0`. |
| Docker + SSH | Infraestructura | Build, despliegue y validación en la VPS del Slot. |
| MiniMax `mmx` | CLI de IA | Segunda opinión de bajo coste para checklist y riesgos; Codex conservó la validación final. |
| `update_plan` / `update_goal` | Herramientas Codex | Seguimiento de la entrega y cierre tras verificación demo. |

## MCP y conectores

No se utilizó un servidor MCP externo para operar MT5, Docker, GitHub o la
VPS. Esas acciones se ejecutaron con herramientas locales y SSH, y fueron
verificadas contra la API desplegada.

MiniMax se usó mediante su CLI (`mmx`), **no** mediante MCP. Su rol fue de
trabajador/revisor de alto volumen; Codex fue la autoridad final de alcance,
seguridad, cambios, pruebas y despliegue.

La sesión también expone conectores/herramientas que se pueden usar cuando
apliquen, pero no se necesitaron en esta entrega:

| Capacidad | Uso previsto |
| --- | --- |
| Navegación web | Búsqueda y verificación de información pública actual. |
| Generación de imágenes | Crear o editar imágenes cuando el producto lo requiera. |
| Browser / Computer Use | Probar interfaces web o controlar aplicaciones de escritorio. |
| Recursos MCP | Leer recursos publicados por servidores MCP configurados. |
| Colaboración multiagente | Dividir subtareas independientes entre agentes Codex. |
| Codex App | Dependencias del workspace, terminal y navegación de tareas. |

## Skills disponibles

### Desarrollo y plataforma

| Skill | Finalidad |
| --- | --- |
| `ponytail` | Solución mínima y mantenible para cualquier tarea de código. |
| `ponytail-audit` | Auditoría completa de sobreingeniería. |
| `ponytail-review` | Revisión de un cambio enfocada en simplificación. |
| `ponytail-debt` | Inventario de comentarios `ponytail:` pendientes. |
| `ponytail-gain` | Resumen de impacto medido de Ponytail. |
| `ponytail-help` | Referencia rápida de los modos Ponytail. |
| `skill-creator` | Crear o mejorar una skill reutilizable. |
| `skill-installer` | Instalar skills curadas o desde GitHub. |
| `plugin-creator` | Crear y estructurar plugins para Codex. |
| `openai-docs` | Guía oficial de productos OpenAI y Codex. |
| `mmx-cli` | Texto, búsqueda y medios mediante MiniMax CLI. |
| `github:github` | Orientación de repositorios, issues y PRs con GitHub. |
| `github:gh-fix-ci` | Diagnóstico y corrección de GitHub Actions. |
| `github:gh-address-comments` | Resolver comentarios de revisión en PRs. |
| `github:yeet` | Commit, push y PR borrador de cambios locales. |

### Interfaces, automatización y artefactos

| Skill | Finalidad |
| --- | --- |
| `browser:control-in-app-browser` | Control del navegador integrado para pruebas web. |
| `computer-use:computer-use` | Control de aplicaciones Windows. |
| `imagegen` | Generación o edición de imágenes raster. |
| `visualize` | Visualizaciones y herramientas interactivas. |
| `sites:sites-building` | Construcción de sitios con OpenAI Sites. |
| `sites:sites-hosting` | Publicación y hosting con OpenAI Sites. |
| `documents:documents` | Creación y revisión visual de documentos Word. |
| `pdf:pdf` | Lectura, generación y verificación de PDF. |
| `presentations:Presentations` | Presentaciones PowerPoint o Google Slides. |
| `spreadsheets:Spreadsheets` | Hojas de cálculo y libros de trabajo. |
| `spreadsheets:excel-live-control` | Control de una sesión activa de Excel. |
| `template-creator:template-creator` | Crear plantillas de artefactos reutilizables. |

### Azure AI Foundry

| Skill | Finalidad |
| --- | --- |
| `microsoft-foundry` | Flujo integral de agentes, evaluación, fine-tuning y despliegue Foundry. |
| `deploy-model` | Enrutador para desplegar modelos Azure OpenAI. |
| `preset` | Despliegue rápido en la mejor región disponible. |
| `customize` | Despliegue con SKU, versión, capacidad y políticas personalizados. |
| `capacity` | Descubrimiento y comparación de cuota/capacidad regional. |
| `finetuning` | SFT, DPO y RFT en Azure AI Foundry. |

## Plugins recomendados, aún no instalados

Disponibles para instalación bajo demanda, pero no usados ni habilitados en
esta sesión: Atlassian Rovo, Box, Figma, Gmail, Google Calendar, Google Drive,
Notion, Outlook Calendar, Outlook Email, SharePoint, Slack y Teams. Se
instalan únicamente cuando una tarea requiere el conector concreto.

## Reglas operativas aplicadas

1. Codex interpreta el objetivo, decide alcance y valida resultados; MiniMax
   puede analizar o proponer, pero no aprueba cambios por sí solo.
2. Nunca se envían a MiniMax contraseñas, tokens, llaves API ni datos privados.
3. Toda acción con efecto externo se verifica directamente: compilación,
   despliegue, salud de contenedor, cuenta MT5, órdenes, posiciones e historial.
4. Los cambios se hacen con el mínimo necesario y se prueban en demo antes de
   declararlos funcionales.
5. Git conserva evidencia: rama `codex/p0-trading`, benchmark documentado y
   release tag `v0.4.0`.

## Referencias de configuración

- Política del repositorio: `AGENTS.md` en la raíz del workspace.
- Regla persistente de este proyecto: Codex orquesta y MiniMax es trabajador
  auxiliar de alto volumen.
- Guía oficial de producto consultada: manual de Codex, secciones de skills,
  plugins, MCP y `AGENTS.md`.
