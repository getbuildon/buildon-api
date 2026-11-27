import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "../error";
import type { AccesoAObra } from "../permisos";
import { nombresDeLaObra } from "./certificaciones";

/**
 * El detalle de una unidad: espejo de getUnitDetailData de la app. Manda las filas; la
 * app arma la pantalla con lib/projects/armarDetalleDeUnidad.ts (la misma función que la
 * server action). Se lee con el token de la persona; los nombres, con el de servicio.
 */

/** Ve la unidad: ve el avance de todas, o es una de las suyas (cliente). Como canAccessUnitProgress. */
export function puedeVerUnidad(acceso: AccesoAObra, unidad: string): boolean {
  if (acceso.unidades === null) return acceso.permisos.viewDetailedProgress === true;
  return acceso.unidades.includes(unidad);
}

const uno = <T>(valor: T | T[] | null | undefined): T | null => (Array.isArray(valor) ? (valor[0] ?? null) : (valor ?? null));

export async function leerDetalleDeUnidad(db: SupabaseClient, servicio: SupabaseClient, obra: string, unidadId: string, acceso: AccesoAObra) {
  if (!puedeVerUnidad(acceso, unidadId)) throw new ApiError(404, "no_existe", "No encontramos esa unidad o no tenés acceso.");
  const [unidad, asignaciones, grupos, avances] = await Promise.all([
    db
      .from("project_units")
      .select("id, code, name, unit_type, room_count, plan_url, render_url, project_floors:floor_id (id, name, identifier)")
      .eq("project_id", obra)
      .eq("id", unidadId)
      .maybeSingle(),
    db.from("unit_task_assignments").select("unit_id, rubro_task_id").eq("project_id", obra),
    db
      .from("rubro_groups")
      .select("id, name, sort_order, rubros (id, name, sort_order, weight_percent, rubro_tasks (id, name, sort_order, weight_percent))")
      .eq("project_id", obra)
      .order("sort_order"),
    db.rpc("latest_progress_entries", { p_project_id: obra, p_unit_id: unidadId }),
  ]);
  if (unidad.error || asignaciones.error || grupos.error || avances.error) {
    throw new ApiError(502, "base", "No pudimos leer la unidad. Probá de nuevo.");
  }
  const fila = unidad.data;
  const piso = uno(fila?.project_floors as unknown as { id: string; name: string; identifier: string | null } | null);
  if (!fila || !piso) throw new ApiError(404, "no_existe", "No encontramos esa unidad o no tenés acceso.");

  const filas = ((avances.data ?? []) as Record<string, unknown>[]).map((a) => ({
    id: a.id as string,
    unit_id: a.unit_id as string | null,
    task_id: a.task_id as string,
    status: a.status as string,
    progress_state: a.progress_state as string,
    created_by: a.created_by as string,
    submitted_at: a.submitted_at as string | null,
    created_at: a.created_at as string,
  }));
  const aprobados = filas.filter((f) => f.status === "approved").map((f) => f.id);
  const validaciones = aprobados.length
    ? await db
        .from("progress_validations")
        .select("progress_entry_id, validated_at, validated_by")
        .in("progress_entry_id", aprobados)
        .eq("decision", "approved")
        .order("validated_at", { ascending: false })
    : { data: [], error: null };
  if (validaciones.error) throw new ApiError(502, "base", "No pudimos leer la unidad. Probá de nuevo.");
  const filasDeValidaciones = (validaciones.data ?? []) as { progress_entry_id: string; validated_at: string; validated_by: string }[];

  const porUnidad: Record<string, string[]> = {};
  for (const a of (asignaciones.data ?? []) as { unit_id: string; rubro_task_id: string }[]) (porUnidad[a.unit_id] ??= []).push(a.rubro_task_id);

  return {
    unidad: {
      id: fila.id,
      code: fila.code,
      name: fila.name,
      unit_type: fila.unit_type,
      room_count: fila.room_count,
      plan_url: fila.plan_url ?? null,
      render_url: fila.render_url ?? null,
    },
    piso: { id: piso.id, name: piso.name, identifier: piso.identifier ?? null },
    grupos: grupos.data ?? [],
    asignaciones: porUnidad,
    avances: filas,
    validaciones: filasDeValidaciones,
    nombres: await nombresDeLaObra(servicio, obra, [...filas.map((f) => f.created_by), ...filasDeValidaciones.map((v) => v.validated_by)]),
  };
}
