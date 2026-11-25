/** Un error que el Worker responde tal cual: código estable para la app y mensaje en español. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const sinSesion = () => new ApiError(401, "sin_sesion", "Tu sesión venció. Volvé a iniciar sesión.");
export const sinPermiso = () => new ApiError(403, "sin_permiso", "No tenés permiso para hacer esto.");
export const noExiste = (que = "Lo que buscás") => new ApiError(404, "no_existe", `${que} no existe o no tenés acceso.`);
