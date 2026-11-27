import type { SupabaseClient } from "@supabase/supabase-js";
import {
  calcularResumen,
  type AvanceDeTarea,
  type PisoDeLaBase,
  type ResumenDeObra,
  type UnidadDeLaBase,
} from "../dominio/resumen";
import type { Rubro, Tarea } from "../dominio/progreso";
import { ApiError } from "../error";

/**
 * Lee el resumen de una obra con el token de la persona: la RLS de la base decide qué
 * filas ve, igual que la pantalla de hoy. Quien llama ya comprobó que puede ver el
 * Dashboard y le pasa qué unidades puede ver (null = todas).
 */
export async function leerResumenDeObra(
  db: SupabaseClient,
  obra: string,
  unidadesPermitidas: string[] | null,
  ahora: Date,
): Promise<ResumenDeObra> {
  const [pisos, unidades, rubros, tareas, asignaciones, avances] = await Promise.all([
    db.from("project_floors").select("id, name, identifier, sort_order").eq("project_id", obra).order("sort_order"),
    db
      .from("project_units")
      .select("id, floor_id, code, name, unit_type, room_count, sort_order")
      .eq("project_id", obra)
      .order("sort_order"),
    db.from("rubros").select("id, weight_percent").eq("project_id", obra),
    db.from("rubro_tasks").select("id, rubro_id").eq("project_id", obra),
    db.from("unit_task_assignments").select("unit_id, rubro_task_id").eq("project_id", obra),
    // El último avance de cada tarea en cada unidad (función de la base).
    db.rpc("latest_progress_entries", { p_project_id: obra }),
  ]);
  if (pisos.error || unidades.error || rubros.error || tareas.error || asignaciones.error || avances.error) {
    throw new ApiError(502, "base", "No pudimos leer el resumen de la obra. Probá de nuevo.");
  }

  const tareasPorUnidad = new Map<string, string[]>();
  for (const fila of (asignaciones.data ?? []) as { unit_id: string; rubro_task_id: string }[]) {
    tareasPorUnidad.set(fila.unit_id, [...(tareasPorUnidad.get(fila.unit_id) ?? []), fila.rubro_task_id]);
  }

  return calcularResumen({
    pisos: (pisos.data ?? []) as PisoDeLaBase[],
    unidades: (unidades.data ?? []) as UnidadDeLaBase[],
    rubros: (rubros.data ?? []) as Rubro[],
    tareas: (tareas.data ?? []) as Tarea[],
    tareasPorUnidad,
    avances: (avances.data ?? []) as AvanceDeTarea[],
    unidadesPermitidas,
    ahora,
  });
}
