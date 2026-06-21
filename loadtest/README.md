# Carga k6 — backend-AgenteX

## 1. Propósito

Este script (`loadtest.js`) mide cómo se comporta la API real bajo concurrencia: si escala y responde dentro de los umbrales definidos. **No verifica lógica de negocio** — eso ya está cubierto por las pruebas unitarias, de integración y E2E (ver `CONTEXTO_TESTING_AGENTEX.md`, sección 8).

**`POST /api/chat/message` queda excluido a propósito** de la carga. Cada llamada de chat dispara una consulta real y pagada a DeepSeek vía el microservicio de IA, sin importar el entorno — correrla con varios VUs implicaría gasto de IA no controlado. Es el mismo criterio que ya aplican el Front (`Front-AgenteX-`) y el microservicio Python (`motor-ia-agenteX`) en sus propias suites de carga k6.

## 2. Diseño del script

`options.scenarios` define dos escenarios que corren **en paralelo** (mismo `startTime` por defecto), cada uno con su propia función vía `exec`:

| Escenario | `exec` | Endpoint | Rampa |
|---|---|---|---|
| `health_check` | `healthCheck()` | `GET /health` | 0→10 VUs (20s) → sostiene 10 VUs (40s) → baja a 0 (10s) |
| `login` | `loginFlow()` | `POST /api/auth/login` | misma rampa: 0→10 VUs (20s) → sostiene 10 VUs (40s) → baja a 0 (10s) |

Como ambos escenarios corren en paralelo, la concurrencia real contra el servidor llega a sumarse (hasta 20 VUs simultáneos en el tramo sostenido: 10 de `health_check` + 10 de `login`).

**Thresholds** (aplicados globalmente sobre el total de ambos escenarios, no por-escenario con tags):

- `http_req_duration`: `p(95)<800ms`
- `http_req_failed`: `rate<1%`

`login` valida además `status 200` y que la respuesta tenga un `token` (`check` por escenario, no es un threshold que aborte la corrida).

## 3. Requisitos previos

1. **Backend levantado con `NODE_ENV=development`.** El backend tiene `generalLimiter` (`express-rate-limit`, 100 req/min por IP sobre todo `/api/*`, definido en `app.js`) con `skip: NODE_ENV === 'development'`. Si se levanta el servidor en modo normal (sin esa variable), la mayoría de los requests de `login` van a fallar con `429` — no por falta de capacidad del servidor, sino por el rate-limiter reaccionando a la ráfaga de VUs desde la misma IP.

2. **Variables de entorno para las credenciales reales del escenario `login`:**
   - `K6_EMAIL` — email de un usuario real existente en la base de datos.
   - `K6_PASSWORD` — contraseña real de ese usuario.
   
   El script las lee con `__ENV.K6_EMAIL` / `__ENV.K6_PASSWORD` sin valores por defecto. Si no se exportan antes de correr k6, el `login` falla de forma visible (credenciales `undefined`), no silenciosa.

3. **⚠️ Advertencia de PowerShell**: `NODE_ENV=development npm run dev` es sintaxis de Bash — en PowerShell **no asigna la variable** (falla silenciosa, sin error visible). Hay que usar:

   ```powershell
   $env:NODE_ENV = 'development'; npm run dev
   ```

   o arrancar el servidor desde Git Bash con la sintaxis de Bash.

## 4. Cómo correr

En una terminal, levantar el backend con el rate-limiter desactivado:

```powershell
$env:NODE_ENV = 'development'; npm run dev
```

En otra terminal, correr k6 con las credenciales reales:

```powershell
$env:K6_EMAIL = 'usuario@empresa.com'; $env:K6_PASSWORD = 'clave-real'; k6 run loadtest/loadtest.js
```

(En Bash/Git Bash: `K6_EMAIL=usuario@empresa.com K6_PASSWORD=clave-real k6 run loadtest/loadtest.js`)

## 5. Resultado de referencia

| Escenario | Métrica real |
|---|---|
| `health_check` | [Pendiente — correr con servidor levantado y credenciales reales] |
| `login` | [Pendiente — correr con servidor levantado y credenciales reales] |

## 6. Qué significa que el test pase vs falle

- **Pasa** (`thresholds` en verde): el servidor respondió dentro de `p(95)<800ms` y con menos de `1%` de errores en ambos escenarios combinados, hasta 20 VUs concurrentes. Indica estabilidad y performance aceptable bajo esa carga.

- **Falla en `login` casi siempre significa rate-limiter activo, no servidor caído.** Si `http_req_failed` se dispara en el escenario `login` (normalmente con un patrón de `429` repetidos), lo primero a verificar es si el `generalLimiter` quedó activo — es decir, si el servidor **no** se levantó con `NODE_ENV=development` (ver sección 3). Confirmarlo con:

  ```bash
  curl -i -X POST http://localhost:3000/api/auth/login \
    -H "Content-Type: application/json" \
    -d '{"email":"usuario@empresa.com","password":"clave-real"}'
  ```

  Si la respuesta trae headers `RateLimit-Limit`, `RateLimit-Policy` o similares, el limiter está activo y eso —no la capacidad real del servidor— es la causa del fallo. Reiniciar el backend con `$env:NODE_ENV = 'development'; npm run dev` y volver a correr la carga antes de concluir que hay un problema de performance real.

  Si la respuesta **no** trae esos headers y el fallo persiste (timeouts, `500`, conexión rechazada), ahí sí se trata de un hallazgo real de estabilidad/performance del servidor bajo esa concurrencia.
