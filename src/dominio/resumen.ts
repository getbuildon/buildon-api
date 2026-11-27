/**
 * El resumen de una obra (el Dashboard): avance por piso y por unidad y los cuatro números
 * de arriba. Espejo de la app (repo getbuildon/buildit): getDashboardData en
 * app/project/[projectId]/configuracion/actions.ts y lib/projects/dashboardProgress.ts.
 * Si cambia la regla en un lado, cambia en el otro.
 */
import { pesosDeRubros, type Rubro, type Tarea } from "./progreso";

export type AvanceDeTarea = {
  unit_id: string | null;
  task_id: string;
  status: string;
  created_at?: string | null;
  submitted_at?: string | null;
};

export type PisoDeLaBase = { id: string; name: string; identifier: string | null; sort_order: number | null };
export type UnidadDeLaBase = {
  id: string;
  floor_id: string | null;
  code: string;
  name: string | null;
  unit_type: string | null;
  room_count: number | null;
  sort_order: number | null;
};

export type UnidadDelResumen = {
  id: string;
  codigo: string;
  nombre: string | null;
  tipo: string | null;
  ambientes: number | null;
  /** 0–100. */
  avance: number;
  /** Tiene alguna tarea cuyo último avance fue rechazado. */
  bloqueada: boolean;
};

export type PisoDelResumen = {
  id: string;
  nombre: string;
  identificador: string | null;
  avance: number;
  unidades: UnidadDelResumen[];
};

export type ResumenDeObra = {
  pisos: PisoDelResumen[];
  numeros: {
    pisos: number;
    unidades: number;
    avance: number;
    terminadas: number;
    certificadas: number;
    certificadasEstaSemana: number;
    bloqueadas: number;
  };
};

export type EntradaDelResumen = {
  pisos: PisoDeLaBase[];
  unidades: UnidadDeLaBase[];
  rubros: Rubro[];
  tareas: Tarea[];
  /** Tareas asignadas por unidad. Vacío = todas las tareas valen para todas las unidades. */
  tareasPorUnidad: Map<string, string[]>;
  avances: AvanceDeTarea[];
  /** null = todas las unidades; lista = solo esas. */
  unidadesPermitidas: string[] | null;
  ahora: Date;
};

const SEMANA_MS = 7 * 24 * 60 * 60 * 1000;

function momento(avance: AvanceDeTarea): number {
  const valor = avance.submitted_at ?? avance.created_at;
  return valor ? new Date(valor).getTime() : 0;
}

const promedio = (valores: number[]) =>
  valores.length === 0 ? 0 : valores.reduce((suma, v) => suma + v, 0) / valores.length;

/** Recorta a 2 decimales hacia abajo, como la app: la versión no cambia por ruido de coma flotante. */
export const recortar = (valor: number) => {
  const abs = Math.floor(Math.abs(valor) * 100 + 1e-8) / 100;
  return valor < 0 ? -abs : abs;
};

export function calcularResumen(entrada: EntradaDelResumen): ResumenDeObra {
  const pesos = pesosDeRubros(entrada.rubros);
  const rubroDeTarea = new Map(entrada.tareas.map((t) => [t.id, t.rubro_id]));
  const todas = entrada.tareas.map((t) => t.id);
  const hayAsignaciones = entrada.tareasPorUnidad.size > 0;
  const asignadas = (unidad: string) => (hayAsignaciones ? (entrada.tareasPorUnidad.get(unidad) ?? []) : todas);

  const permitidas = entrada.unidadesPermitidas ? new Set(entrada.unidadesPermitidas) : null;
  const visibles = permitidas ? entrada.unidades.filter((u) => permitidas.has(u.id)) : entrada.unidades;
  const idsVisibles = new Set(visibles.map((u) => u.id));

  // Último avance de cada tarea en cada unidad (solo tareas asignadas a esa unidad).
  const ultimos = (avances: AvanceDeTarea[]) => {
    const porClave = new Map<string, AvanceDeTarea>();
    for (const avance of avances) {
      if (!avance.unit_id || !avance.task_id) continue;
      if (!idsVisibles.has(avance.unit_id)) continue;
      if (!asignadas(avance.unit_id).includes(avance.task_id)) continue;
      const clave = `${avance.unit_id}:${avance.task_id}`;
      const previo = porClave.get(clave);
      if (!previo || momento(avance) > momento(previo)) porClave.set(clave, avance);
    }
    return porClave;
  };
  const ultimo = ultimos(entrada.avances);

  const avanceDeUnidad = (unidad: string): number => {
    const tareas = asignadas(unidad);
    if (tareas.length === 0) return 0;
    const porRubro = new Map<string, string[]>();
    for (const tarea of tareas) {
      const rubro = rubroDeTarea.get(tarea);
      if (!rubro) continue;
      porRubro.set(rubro, [...(porRubro.get(rubro) ?? []), tarea]);
    }
    let total = 0;
    for (const [rubro, deRubro] of porRubro) {
      const peso = pesos.get(rubro) ?? 0;
      if (peso <= 0 || deRubro.length === 0) continue;
      const certificadas = deRubro.filter((t) => ultimo.get(`${unidad}:${t}`)?.status === "approved").length;
      total += peso * (certificadas / deRubro.length);
    }
    return total;
  };

  const bloqueada = (unidad: string) =>
    asignadas(unidad).some((t) => ultimo.get(`${unidad}:${t}`)?.status === "rejected");

  const orden = (a: { sort_order: number | null }, b: { sort_order: number | null }) =>
    (a.sort_order ?? 0) - (b.sort_order ?? 0);

  const avancesCrudos: number[][] = [];
  const pisos: PisoDelResumen[] = [];
  for (const piso of [...entrada.pisos].sort(orden)) {
    const deEstePiso = visibles.filter((u) => u.floor_id === piso.id).sort(orden);
    if (deEstePiso.length === 0) continue;
    const crudos = deEstePiso.map((u) => avanceDeUnidad(u.id));
    avancesCrudos.push(crudos);
    pisos.push({
      id: piso.id,
      nombre: piso.name,
      identificador: piso.identifier ?? null,
      avance: recortar(promedio(crudos)),
      unidades: deEstePiso.map((u, i) => ({
        id: u.id,
        codigo: u.code,
        nombre: u.name,
        tipo: u.unit_type,
        ambientes: u.room_count,
        avance: recortar(crudos[i]!),
        bloqueada: bloqueada(u.id),
      })),
    });
  }

  const enLaSemana = new Map(
    [...ultimo].filter(([, a]) => {
      const t = momento(a);
      return t > 0 && t >= entrada.ahora.getTime() - SEMANA_MS;
    }),
  );
  const contar = (mapa: Map<string, AvanceDeTarea>, estado: string) =>
    [...mapa.values()].filter((a) => a.status === estado).length;

  const todasLasUnidades = avancesCrudos.flat();
  return {
    pisos,
    numeros: {
      pisos: pisos.length,
      unidades: todasLasUnidades.length,
      avance: recortar(promedio(avancesCrudos.map(promedio))),
      terminadas: todasLasUnidades.filter((v) => Math.round(v) === 100).length,
      certificadas: contar(ultimo, "approved"),
      certificadasEstaSemana: contar(enLaSemana, "approved"),
      bloqueadas: contar(ultimo, "rejected"),
    },
  };
}
