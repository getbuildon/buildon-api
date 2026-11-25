import { ambiente, type Entorno } from "./entorno";

/**
 * La puerta del navegador (como Rootsy, R-BFF): la app llama directo al Worker con el
 * token de la persona; la base aplica la RLS. Acá se decide el origen (CORS), el límite
 * de pedidos y la hora del servidor.
 */
const ORIGENES: Record<"local" | "test" | "produccion", string[]> = {
  produccion: ["https://getbuildon.com", "https://www.getbuildon.com"],
  test: ["https://test.getbuildon.com"],
  local: [],
};
const LOCAL = ["http://localhost:3000", "http://127.0.0.1:3000"];

export function origenesPermitidos(env: Pick<Entorno, "BUILDON_ENV" | "APP_PUBLIC_URL">): Set<string> {
  const amb = ambiente(env);
  const origenes = new Set(ORIGENES[amb]);
  if (amb !== "produccion") for (const o of LOCAL) origenes.add(o);
  try {
    const app = env.APP_PUBLIC_URL?.trim();
    if (app) {
      const origen = new URL(app).origin;
      // Producción nunca acepta una app local o de test, aunque la variable lo diga.
      if (amb !== "produccion" || !/localhost|127\.0\.0\.1|test\./.test(origen)) origenes.add(origen);
    }
  } catch {
    /* APP_PUBLIC_URL rota: quedan los fijos */
  }
  return origenes;
}

export function encabezadosCors(origen: string): Record<string, string> {
  return {
    "access-control-allow-origin": origen,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, x-buildon-pedido",
    "access-control-expose-headers": "x-buildon-hora",
    // Lo máximo que guarda Chrome: una consulta previa cada 2 h por dirección.
    "access-control-max-age": "7200",
    vary: "Origin",
  };
}

const json = (cuerpo: unknown, status: number, headers: Record<string, string> = {}) =>
  Response.json(cuerpo, { status, headers });

/** Rutas que se pueden llamar sin sesión (salud). Todo lo demás exige token. */
const SIN_SESION = new Set(["GET /salud"]);

export async function puertaDelNavegador(
  request: Request,
  env: Entorno,
  atender: () => Promise<Response>,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  const origen = request.headers.get("origin") ?? "";
  const permitido = origen !== "" && origenesPermitidos(env).has(origen);

  if (request.method === "OPTIONS") {
    return permitido ? new Response(null, { status: 204, headers: encabezadosCors(origen) }) : new Response(null, { status: 403 });
  }
  // Sin origen: un llamado de servidor o de herramienta (curl). Se atiende sin CORS;
  // igual exige token en las rutas con sesión.
  if (origen !== "" && !permitido) return json({ code: "origen", message: "Origen no permitido." }, 403);

  const conSesion = !SIN_SESION.has(`${request.method} ${pathname}`);
  const limitador = conSesion ? env.LIMITE_SESION : env.LIMITE_NAVEGADOR;
  const ip = request.headers.get("cf-connecting-ip") ?? "";
  if (limitador && ip) {
    const { success } = await limitador.limit({ key: `${pathname}:${ip}` });
    if (!success) {
      return json({ code: "tope", message: "Muchos pedidos seguidos. Probá de nuevo en un minuto." }, 429, {
        ...(permitido ? encabezadosCors(origen) : {}),
        "retry-after": "60",
      });
    }
  }

  const respuesta = await atender();
  const salida = new Response(respuesta.body, respuesta);
  if (permitido) for (const [k, v] of Object.entries(encabezadosCors(origen))) salida.headers.set(k, v);
  // Hora del servidor en ms: ordena lo que se cargó sin señal con un reloj confiable.
  salida.headers.set("x-buildon-hora", String(Date.now()));
  return salida;
}
