import { Hono, type Context } from "hono";
import { ambiente, type Entorno } from "./entorno";
import { ApiError } from "./error";
import { puertaDelNavegador } from "./navegador";
import { leerArranque, versionDe } from "./rutas/arranque";
import { leerProgresoDeObras } from "./rutas/progreso";
import { clienteDePersona, clienteDeServicio, sesionDe } from "./supabase";

const app = new Hono<{ Bindings: Entorno }>();

app.get("/salud", (c) => c.json({ ok: true, ambiente: ambiente(c.env) }));

/** Responde los datos con su versión; si la app ya tiene esa versión, solo avisa que no cambió. */
async function conVersion(c: Context<{ Bindings: Entorno }>, datos: object) {
  const version = await versionDe(datos);
  c.header("cache-control", "no-store");
  if (c.req.query("desde") === version) return c.json({ sinCambios: true, version });
  return c.json({ version, ...datos });
}

app.get("/arranque", async (c) => {
  const sesion = await sesionDe(c.env, c.req.raw);
  const db = clienteDePersona(c.env, sesion.token);
  return conVersion(c, await leerArranque(db, sesion.userId, sesion.email, c.env.BACKOFFICE_ALLOWED_EMAILS));
});

/** Avance general y semanal de las obras de la persona (tarjetas del inicio). */
app.get("/inicio/progreso", async (c) => {
  const sesion = await sesionDe(c.env, c.req.raw);
  // Las obras salen de la lectura con el token de la persona: la RLS decide cuáles ve.
  const arranque = await leerArranque(clienteDePersona(c.env, sesion.token), sesion.userId, sesion.email);
  const obras = arranque.obras.filter((o) => o.estado !== "draft").map((o) => o.id);
  const progreso = await leerProgresoDeObras(clienteDeServicio(c.env), obras, new Date());
  // Redondeado a 2 decimales para que la versión no cambie por ruido de coma flotante.
  const redondo = Object.fromEntries(
    Object.entries(progreso).map(([id, p]) => [
      id,
      { general: Math.floor(p.general * 100 + 1e-8) / 100, semanal: Math.round(p.semanal * 100) / 100 },
    ]),
  );
  return conVersion(c, { progreso: redondo });
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
