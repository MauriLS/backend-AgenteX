// backend/loadtest/loadtest.js
//
// Prueba de carga (k6) — mide cómo se comporta la API bajo concurrencia.
// No verifica lógica de negocio (eso ya está cubierto por unitarias/integración/E2E),
// solo si el servidor escala y responde dentro de los umbrales definidos.
//
// Requiere el servidor real corriendo: npm run dev (en otra terminal)
// Ejecutar: k6 run loadtest.js

import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  stages: [
    { duration: "20s", target: 10 }, // sube a 10 usuarios virtuales
    { duration: "40s", target: 10 }, // mantiene 10 VUs
    { duration: "10s", target: 0 },  // baja a 0
  ],
  thresholds: {
    http_req_duration: ["p(95)<800"], // p95 < 800 ms
    http_req_failed:   ["rate<0.01"], // < 1% de errores
  },
};

const BASE_URL = "http://localhost:3000";

export default function () {
  const res = http.get(`${BASE_URL}/health`);
  check(res, {
    "status 200": (r) => r.status === 200,
    "respuesta correcta": (r) => r.json("status") === "ok",
  });
  sleep(1);
}