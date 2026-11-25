import type { SupabaseClient } from "@supabase/supabase-js";
import { avanceDeInicio, type Avance, type AvanceDeInicio, type EstructuraDeObra } from "../dominio/progreso";
import { ApiError } from "../error";

/**
 * Avance general y semanal de cada obra, para las tarjetas del inicio.
 * Se lee con el cliente de servicio: un cliente solo puede leer los avances de su
 * unidad, pero la tarjeta muestra el de toda la obra. Quien llama ya filtró las obras
 * a las que la persona tiene acceso, y de acá solo salen porcentajes, nunca filas.
 */
export async function leerProgresoDeObras(
  servicio: SupabaseClient,
  obras: string[],
  ahora: Date,
): Promise<Record<string, AvanceDeInicio>> {
  if (obras.length === 0) return {};
  const [pisos, unidades, rubros, tareas, asignaciones, avances] = await Promise.all([
    servicio.from("project_floors").select("id, project_id").in("project_id", obras),
    servicio.from("project_units").select("id, project_id, floor_id").in("project_id", obras),
    servicio.from("rubros").select("id, project_id, weight_percent").in("project_id", obras),
    servicio.from("rubro_tasks").select("id, project_id, rubro_id").in("project_id", obras),
    servicio.from("unit_task_assignments").select("project_id, unit_id, rubro_task_id").in("project_id", obras),
    servicio
      .from("progress_entries")
      .select("project_id, unit_id, task_id, status, submitted_at, created_at")
      .in("project_id", obras),
  ]);
  if (pisos.error || unidades.error || rubros.error || tareas.error || asignaciones.error || avances.error) {
    throw new ApiError(502, "base", "No pudimos calcular el avance de las obras. Probá de nuevo.");
  }

  const de = <T extends { project_id: string }>(filas: T[] | null, obra: string) =>
    (filas ?? []).filter((f) => f.project_id === obra);

  const resultado: Record<string, AvanceDeInicio> = {};
  for (const obra of obras) {
    const pisosDeObra = de(pisos.data as { id: string; project_id: string }[], obra);
    const unidadesDeObra = de(unidades.data as { id: string; project_id: string; floor_id: string }[], obra);
    const tareasPorUnidad = new Map<string, string[]>();
    for (const a of de(asignaciones.data as { project_id: string; unit_id: string; rubro_task_id: string }[], obra)) {
      tareasPorUnidad.set(a.unit_id, [...(tareasPorUnidad.get(a.unit_id) ?? []), a.rubro_task_id]);
    }
    const estructura: EstructuraDeObra = {
      unidadesPorPiso:
        pisosDeObra.length > 0
          ? pisosDeObra.map((p) => unidadesDeObra.filter((u) => u.floor_id === p.id).map((u) => u.id))
          : [unidadesDeObra.map((u) => u.id)],
      tareas: de(tareas.data as { id: string; project_id: string; rubro_id: string }[], obra),
      rubros: de(rubros.data as { id: string; project_id: string; weight_percent: number | null }[], obra),
      tareasPorUnidad,
    };
    resultado[obra] = avanceDeInicio(estructura, de(avances.data as (Avance & { project_id: string })[], obra), ahora);
  }
  return resultado;
}
