// backend/loadtest/loadtest.js
//
// Prueba de carga (k6) — mide cómo se comporta la API bajo concurrencia.
// No verifica lógica de negocio (eso ya está cubierto por unitarias/integración/E2E),
// solo si el servidor escala y responde dentro de los umbrales definidos.
//
// Requiere el servidor real corriendo: npm run dev (en otra terminal)
// Requiere credenciales reales para el escenario de login:
//   $env:K6_EMAIL = "usuario@empresa.com"; $env:K6_PASSWORD = "clave-real"
// Ejecutar: k6 run loadtest.js

import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = "http://localhost:3000";
const K6_EMAIL = __ENV.K6_EMAIL;
const K6_PASSWORD = __ENV.K6_PASSWORD;

export const options = {
  scenarios: {
    health_check: {
      executor: "ramping-vus",
      exec: "healthCheck",
      startVUs: 0,
      stages: [
        { duration: "20s", target: 10 }, // sube a 10 usuarios virtuales
        { duration: "40s", target: 10 }, // mantiene 10 VUs
        { duration: "10s", target: 0 },  // baja a 0
      ],
    },
    login: {
      executor: "ramping-vus",
      exec: "loginFlow",
      startVUs: 0,
      stages: [
        { duration: "20s", target: 10 },
        { duration: "40s", target: 10 },
        { duration: "10s", target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<800"], // p95 < 800 ms
    http_req_failed:   ["rate<0.01"], // < 1% de errores
  },
};

export function healthCheck() {
  const res = http.get(`${BASE_URL}/health`);
  check(res, {
    "status 200": (r) => r.status === 200,
    "respuesta correcta": (r) => r.json("status") === "ok",
  });
  sleep(1);
}

export function loginFlow() {
  const res = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ email: K6_EMAIL, password: K6_PASSWORD }),
    { headers: { "Content-Type": "application/json" } }
  );
  check(res, {
    "status 200": (r) => r.status === 200,
    "token presente": (r) => !!r.json("token"),
  });
  sleep(1);
}