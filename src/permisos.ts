/**
 * Matriz de permisos por obra: espejo de la app (repo getbuildon/buildit: lib/project/projectPermissions.ts +
 * lib/project/resolveProjectAccess.ts de la app y de has_project_permission() en la base
 * (migración 20261124130000_rls_por_rol). Si cambia una, cambian las tres.
 * La base es la que manda (RLS); esto solo le dice a la pantalla qué mostrar.
 */
export type TipoDeUsuario = "owner" | "admin" | "supervisor" | "operador" | "cliente";

export type Permiso =
  | "addUsers"
  | "editPermissions"
  | "configureProject"
  | "viewDashboard"
  | "viewDetailedProgress"
  | "loadProgress"
  | "certifyTasks"
  | "editTasks"
  | "viewAuditLog"
  | "clientPortal"
  | "manageClients";

export type ValorDePermiso = boolean | "unitOnly";
export type Permisos = Record<Permiso, ValorDePermiso>;

const T = true;
const F = false;
// Columnas: owner, admin, supervisor, operador, cliente.
const MATRIZ: Record<Permiso, [ValorDePermiso, ValorDePermiso, ValorDePermiso, ValorDePermiso, ValorDePermiso]> = {
  addUsers: [T, T, F, F, F],
  editPermissions: [T, T, F, F, F],
  configureProject: [T, T, F, F, F],
  viewDashboard: [T, T, T, T, F],
  viewDetailedProgress: [T, T, T, T, "unitOnly"],
  loadProgress: [T, T, T, T, F],
  certifyTasks: [T, T, T, F, F],
  editTasks: [T, T, T, T, F],
  viewAuditLog: [T, T, T, T, F],
  clientPortal: [F, F, F, F, T],
  manageClients: [T, T, F, F, F],
};
const COLUMNA: Record<TipoDeUsuario, number> = { owner: 0, admin: 1, supervisor: 2, operador: 3, cliente: 4 };

/** Owner/admin de la empresa: configuración y lectura, sin acciones de campo. */
const CAPA_EMPRESA: Permisos = {
  addUsers: T,
  editPermissions: T,
  configureProject: T,
  viewDashboard: T,
  viewDetailedProgress: T,
  loadProgress: F,
  certifyTasks: F,
  editTasks: F,
  viewAuditLog: T,
  clientPortal: F,
  manageClients: T,
};

const PERMISOS = Object.keys(MATRIZ) as Permiso[];

function vacios(): Permisos {
  return Object.fromEntries(PERMISOS.map((p) => [p, false])) as Permisos;
}

export function permisosDeTipo(tipo: TipoDeUsuario): Permisos {
  return Object.fromEntries(PERMISOS.map((p) => [p, MATRIZ[p][COLUMNA[tipo]]])) as Permisos;
}

function unir(a: ValorDePermiso, b: ValorDePermiso): ValorDePermiso {
  if (a === true || b === true) return true;
  if (a === "unitOnly" || b === "unitOnly") return "unitOnly";
  return false;
}

export type AccesoAObra = {
  tipo: TipoDeUsuario;
  permisos: Permisos;
  /** null = todas las unidades; lista = solo esas (cliente). */
  unidades: string[] | null;
};

/** Une las capas como la app: tipo en la obra + empresa + cliente. null = sin acceso. */
export function resolverAcceso(entrada: {
  tipoEnObra: TipoDeUsuario | null;
  adminDeEmpresa: boolean;
  unidadesDeCliente: string[];
}): AccesoAObra | null {
  const { tipoEnObra, adminDeEmpresa, unidadesDeCliente } = entrada;
  const esCliente = unidadesDeCliente.length > 0;
  if (!tipoEnObra && !adminDeEmpresa && !esCliente) return null;

  let permisos = vacios();
  if (tipoEnObra) permisos = permisosDeTipo(tipoEnObra);
  if (adminDeEmpresa) {
    for (const p of PERMISOS) permisos[p] = unir(permisos[p], CAPA_EMPRESA[p]);
  }
  if (esCliente) {
    permisos.clientPortal = true;
    // Como la app con loginAudience "cliente" y como la RLS: ve el avance de sus unidades.
    if (permisos.viewDetailedProgress === false) permisos.viewDetailedProgress = "unitOnly";
  }

  const tipo: TipoDeUsuario = tipoEnObra ?? (adminDeEmpresa ? "admin" : "cliente");
  const unidades =
    permisos.viewDetailedProgress === true ? null : permisos.viewDetailedProgress === "unitOnly" ? unidadesDeCliente : [];
  return { tipo, permisos, unidades };
}
