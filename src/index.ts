import { Hono } from "hono";
import { ambiente, type Entorno } from "./entorno";
import { ApiError } from "./error";
import { puertaDelNavegador } from "./navegador";
import { leerArranque, versionDe } from "./rutas/arranque";
import { clienteDePersona, sesionDe } from "./supabase";

const app = new Hono<{ Bindings: Entorno }>();

app.get("/salud", (c) => c.json({ ok: true, ambiente: ambiente(c.env) }));

app.get("/arranque", async (c) => {
  const sesion = await sesionDe(c.env, c.req.raw);
  const datos = await leerArranque(clienteDePersona(c.env, sesion.token), sesion.userId, sesion.email);
  const version = await versionDe(datos);
  c.header("cache-control", "no-store");
  if (c.req.query("desde") === version) return c.json({ sinCambios: true, version });
  return c.json({ version, ...datos });
});

app.notFound((c) => c.json({ code: "no_existe", message: "Esa dirección no existe." }, 404));

app.onError((error, c) => {
  if (error instanceof ApiError) {
    return c.json({ code: error.code, message: error.message }, error.status as 400);
  }
  console.error("error sin manejar", error);
  return c.json({ code: "interno", message: "Algo salió mal. Probá de nuevo." }, 500);
});

function medir(env: Entorno, request: Request, status: number, desde: number) {
  try {
    env.METRICAS?.writeDataPoint({
      blobs: [request.method, new URL(request.url).pathname, String(status)],
      doubles: [Date.now() - desde, status],
      indexes: [new URL(request.url).pathname],
    });
  } catch {
    /* medir nunca rompe un pedido */
  }
}

export default {
  async fetch(request: Request, env: Entorno, ctx: ExecutionContext): Promise<Response> {
    const desde = Date.now();
    const respuesta = await puertaDelNavegador(request, env, async () => app.fetch(request, env, ctx));
    medir(env, request, respuesta.status, desde);
    return respuesta;
  },
} satisfies ExportedHandler<Entorno>;
