# Worker MiniMax: acceso y reglas de operación

## Hosts

| Rol | Host | Uso |
| --- | --- | --- |
| Worker de IA | `5.189.142.179` | Ejecutar análisis largos, exploración, borradores y trabajo repetitivo con MiniMax/OpenCode. |
| Slot MT5 | `45.151.122.104` | Ejecutar, validar y desplegar `AkronCloud-Slot`. |

No guardar contraseñas, tokens, claves SSH ni archivos `.env` en este repositorio. El acceso se hace con el secreto almacenado fuera de Git o con una clave SSH autorizada.

## Conexión al worker

```bash
ssh root@5.189.142.179
```

En el primer acceso, verificar la huella SSH por un canal confiable. Dentro del worker, comprobar que MiniMax está disponible:

```bash
mmx auth status
mmx quota show --output json
```

Si el proyecto no está presente, clonar el repositorio en una ruta de trabajo del servidor y usar una rama explícita. Nunca trabajar directamente sobre `master` sin revisar el estado de Git.

## Regla de roles

- Codex define objetivo, alcance, riesgos, arquitectura y aceptación final.
- MiniMax es el trabajador por defecto para lectura extensa, inventarios, diagnósticos iniciales, borradores, refactors repetitivos, pruebas propuestas y documentación.
- Codex comprueba siempre el resultado con archivos, tests, builds o el entorno real antes de aceptarlo o desplegarlo.
- Las credenciales, secretos, datos de clientes y archivos `.env` no se envían a MiniMax.

## Forma de pedir trabajo a MiniMax

Dar una tarea acotada con contexto mínimo y pedir una salida estructurada: hallazgos, parche propuesto, comandos de prueba y riesgos. Para ejecución no interactiva:

```bash
mmx text chat \
  --non-interactive --quiet --output json \
  --model MiniMax-M3 \
  --message "user: <tarea concreta sin secretos>"
```

Para respuestas largas, guardar la salida en un archivo temporal y revisar solo las secciones necesarias. No pegar historiales completos ni logs sin filtrar.

## Reglas para ahorrar tokens

1. Delegar a MiniMax primero la lectura de archivos largos, búsquedas, comparaciones, inventarios y borradores.
2. Enviar solo los archivos o fragmentos necesarios; nunca el repositorio completo por defecto.
3. Pedir resultados breves y accionables: JSON, lista de cambios, diff o resumen de decisiones.
4. Filtrar antes de enviar: `rg`, `jq`, rangos de líneas y logs recientes.
5. Separar tareas grandes en subtareas independientes y reutilizar los resultados ya verificados.
6. Codex no repite la investigación: revisa evidencia, aplica cambios con control de versiones y ejecuta la validación final.
7. Builds, despliegues, pruebas reales y comandos destructivos se ejecutan con controles locales/VPS; la respuesta de MiniMax no es evidencia suficiente.

## Flujo recomendado

1. Codex define una tarea y el criterio de éxito.
2. MiniMax analiza o propone la implementación sin secretos.
3. Codex revisa el resultado y aplica el cambio mínimo.
4. El worker o la VPS ejecuta build/tests.
5. Codex verifica el resultado y solo entonces realiza el despliegue autorizado.

## Limpieza

Eliminar scripts temporales, tokens de sesión y artefactos de diagnóstico al terminar. Mantener commits pequeños, con binarios compilados solo cuando el proyecto los requiera.
