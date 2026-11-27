import { Hono, type Context } from "hono";
import { ambiente, type Entorno } from "./entorno";
import { ApiError } from "./error";
import { puertaDelNavegador } from "./navegador";
import { accesoAObra, leerArranque, versionDe } from "./rutas/arranque";
import { leerProgresoDeObras } from "./rutas/progreso";
import { leerResumenDeObra } from "./rutas/resumen";
import { leerTrabajoDeObra } from "./rutas/trabajo";
import { cambiarEstado, cuerpoDeAdjuntos, cuerpoDeAvance, guardarAvance, registrarAdjuntos } from "./rutas/avances";
import { cuerpoDeCambio, leerDetalleDeAvance } from "./rutas/detalle";
import { certificar, cuerpoDeCertificacion, leerCertificaciones } from "./rutas/certificaciones";
import { horaDeCarga } from "./rutas/avances";
import { leerDetalleDeUnidad } from "./rutas/unidad";
import type { Permiso } from "./permisos";
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

/**
 * La obra pedida, si la persona tiene ese permiso en ella. El acceso sale de la misma
 * lectura que el inicio: qué tipo de usuario es y qué puede ver. Sin acceso: 404 (no se
 * dice si la obra existe).
 */
async function obraConPermiso(c: Context<{ Bindings: Entorno }>, permiso: Permiso | Permiso[] | null) {
  const sesion = await sesionDe(c.env, c.req.raw);
  const db = clienteDePersona(c.env, sesion.token);
  const obraId = c.req.param("id") ?? "";
  // Solo el acceso a esta obra: una tanda de consultas en paralelo.
  const obra = await accesoAObra(db, sesion.userId, obraId);
  const pedidos = permiso === null ? [] : Array.isArray(permiso) ? permiso : [permiso];
  if (!obra || (pedidos.length > 0 && !pedidos.some((p) => obra.acceso.permisos[p] === true))) {
    throw new ApiError(404, "sin_acceso", "No encontramos esa obra o no tenés acceso a esta sección.");
  }
  return { db, obra, sesion };
}

/** El cuerpo JSON validado; si no cumple, 400 con un mensaje claro. */
async function cuerpoValidado<T>(c: Context<{ Bindings: Entorno }>, esquema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } }): Promise<T> {
  const crudo = await c.req.json().catch(() => null);
  const resultado = esquema.safeParse(crudo);
  if (!resultado.success) throw new ApiError(400, "invalido", "Los datos enviados no son válidos.");
  return resultado.data;
}

/** El resumen de una obra: el Dashboard (avance por piso y por unidad, y los números de arriba). */
app.get("/obras/:id/resumen", async (c) => {
  const { db, obra } = await obraConPermiso(c, "viewDashboard");
  return conVersion(c, await leerResumenDeObra(db, obra.id, obra.acceso.unidades, new Date()));
});

/** Trabajo diario: estructura de la obra, tareas y el último avance de cada una. */
app.get("/obras/:id/trabajo", async (c) => {
  const { db, obra } = await obraConPermiso(c, "loadProgress");
  return conVersion(c, await leerTrabajoDeObra(db, obra.id));
});

/** Cargar avance. Se puede repetir sin duplicar: los ids de cada avance los pone la app. */
app.post("/obras/:id/avances", async (c) => {
  const { db, obra, sesion } = await obraConPermiso(c, "loadProgress");
  const cuerpo = await cuerpoValidado(c, cuerpoDeAvance);
  return c.json(await guardarAvance(db, obra.id, sesion.userId, cuerpo, new Date()));
});

/** Las fotos de un avance (ya subidas al almacenamiento). También se puede repetir. */
app.post("/obras/:id/adjuntos", async (c) => {
  // Fotos de una carga nueva (cargar avance) o de un cambio de estado (editar).
  const { db, obra, sesion } = await obraConPermiso(c, ["loadProgress", "editTasks"]);
  const cuerpo = await cuerpoValidado(c, cuerpoDeAdjuntos);
  return c.json(await registrarAdjuntos(db, obra.id, sesion.userId, cuerpo));
});

/** El detalle de un trabajo cargado (estado, comentarios, fotos, historial). */
app.get("/obras/:id/avances/:avance", async (c) => {
  const { db, obra } = await obraConPermiso(c, null);
  return conVersion(c, await leerDetalleDeAvance(db, clienteDeServicio(c.env), obra.id, c.req.param("avance"), obra.acceso));
});

/** Cambiar el estado de un trabajo cargado: suma un avance nuevo. Se puede repetir sin duplicar. */
app.post("/obras/:id/avances/:avance/cambio", async (c) => {
  const { db, obra, sesion } = await obraConPermiso(c, "editTasks");
  const cuerpo = await cuerpoValidado(c, cuerpoDeCambio);
  const acceso = { unidades: obra.acceso.unidades, puedeCertificar: obra.acceso.permisos.certifyTasks === true };
  return c.json(await cambiarEstado(db, obra.id, sesion.userId, c.req.param("avance"), cuerpo, acceso, new Date()));
});

/** Certificaciones: tareas completadas para certificar y las ya certificadas. */
app.get("/obras/:id/certificaciones", async (c) => {
  const { db, obra } = await obraConPermiso(c, "viewDashboard");
  return conVersion(c, await leerCertificaciones(db, clienteDeServicio(c.env), obra.id, obra.acceso.permisos.certifyTasks === true));
});

/** Certificar una o varias tareas. Se puede repetir sin duplicar. */
app.post("/obras/:id/certificaciones", async (c) => {
  const { db, obra, sesion } = await obraConPermiso(c, "certifyTasks");
  const cuerpo = await cuerpoValidado(c, cuerpoDeCertificacion);
  return c.json(await certificar(db, obra.id, sesion.userId, cuerpo, horaDeCarga(cuerpo.hechoEn, new Date())));
});

/** El detalle de una unidad: avance y tareas con su estado. */
app.get("/obras/:id/unidades/:unidad", async (c) => {
  const { db, obra } = await obraConPermiso(c, null);
  return conVersion(c, await leerDetalleDeUnidad(db, clienteDeServicio(c.env), obra.id, c.req.param("unidad"), obra.acceso));
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
