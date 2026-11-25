/**
 * Cálculo del avance de obra. Espejo de la app (repo getbuildon/buildit):
 * lib/projects/dashboardProgress.ts, rubroWeights.ts y homeProjectProgress.ts.
 * Si cambia la regla en un lado, cambia en el otro.
 *
 * Regla: la obra es el promedio de sus pisos; el piso, el promedio de sus unidades;
 * la unidad suma el peso de cada rubro por la fracción de sus tareas certificadas
 * (último avance de la tarea con status "approved").
 */
export type Avance = {
  unit_id: string | null;
  task_id: string;
  status: string;
  created_at?: string | null;
  submitted_at?: string | null;
};

export type Rubro = { id: string; weight_percent: number | null };
export type Tarea = { id: string; rubro_id: string };

function momento(avance: Avance): number {
  const valor = avance.submitted_at ?? avance.created_at;
  return valor ? new Date(valor).getTime() : 0;
}

/** Peso efectivo de cada rubro: el manual, o el resto de 100 repartido entre los automáticos. */
export function pesosDeRubros(rubros: Rubro[]): Map<string, number> {
  const pesos = new Map<string, number>();
  let manual = 0;
  const automaticos: string[] = [];
  for (const rubro of rubros) {
    if (rubro.weight_percent != null) {
      pesos.set(rubro.id, rubro.weight_percent);
      manual += rubro.weight_percent;
    } else {
      automaticos.push(rubro.id);
    }
  }
  const parte = automaticos.length > 0 ? Math.max(0, 100 - manual) / automaticos.length : 0;
  for (const id of automaticos) pesos.set(id, parte);
  return pesos;
}

export type EstructuraDeObra = {
  /** Unidades de cada piso (si la obra no tiene pisos: una sola lista con todas). */
  unidadesPorPiso: string[][];
  tareas: Tarea[];
  rubros: Rubro[];
  /** Tareas asignadas por unidad. Vacío = todas las tareas valen para todas las unidades. */
  tareasPorUnidad: Map<string, string[]>;
};

function promedio(valores: number[]): number {
  return valores.length === 0 ? 0 : valores.reduce((suma, v) => suma + v, 0) / valores.length;
}

export function avanceDeObra(obra: EstructuraDeObra, avances: Avance[]): number {
  if (obra.unidadesPorPiso.length === 0) return 0;
  const pesos = pesosDeRubros(obra.rubros);
  const rubroDeTarea = new Map(obra.tareas.map((t) => [t.id, t.rubro_id]));
  const todas = obra.tareas.map((t) => t.id);
  const hayAsignaciones = obra.tareasPorUnidad.size > 0;

  // Último avance por unidad y tarea.
  const ultimo = new Map<string, Avance>();
  for (const avance of avances) {
    if (!avance.unit_id || !avance.task_id) continue;
    const clave = `${avance.unit_id}:${avance.task_id}`;
    const previo = ultimo.get(clave);
    if (!previo || momento(avance) > momento(previo)) ultimo.set(clave, avance);
  }

  const avanceDeUnidad = (unidad: string): number => {
    const asignadas = hayAsignaciones ? (obra.tareasPorUnidad.get(unidad) ?? []) : todas;
    const porRubro = new Map<string, string[]>();
    for (const tarea of asignadas) {
      const rubro = rubroDeTarea.get(tarea);
      if (!rubro) continue;
      porRubro.set(rubro, [...(porRubro.get(rubro) ?? []), tarea]);
    }
    let total = 0;
    for (const [rubro, tareas] of porRubro) {
      const peso = pesos.get(rubro) ?? 0;
      if (peso <= 0) continue;
      const certificadas = tareas.filter((t) => ultimo.get(`${unidad}:${t}`)?.status === "approved").length;
      total += peso * (certificadas / tareas.length);
    }
    return total;
  };

  return promedio(obra.unidadesPorPiso.map((unidades) => promedio(unidades.map(avanceDeUnidad))));
}

export type AvanceDeInicio = { general: number; semanal: number };

/** Avance de hoy y cuánto cambió respecto de hace 7 días. */
export function avanceDeInicio(obra: EstructuraDeObra, avances: Avance[], ahora: Date): AvanceDeInicio {
  const general = avanceDeObra(obra, avances);
  const corte = ahora.getTime() - 7 * 24 * 60 * 60 * 1000;
  const antes = avances.filter((a) => {
    const t = momento(a);
    return t > 0 && t <= corte;
  });
  return { general, semanal: general - avanceDeObra(obra, antes) };
}
