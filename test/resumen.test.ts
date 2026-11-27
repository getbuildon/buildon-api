import { describe, expect, it } from "vitest";
import { calcularResumen, type EntradaDelResumen } from "../src/dominio/resumen";

const ahora = new Date("2026-11-26T12:00:00Z");
const haceDias = (dias: number) => new Date(ahora.getTime() - dias * 86_400_000).toISOString();

const base: EntradaDelResumen = {
  pisos: [
    { id: "p2", name: "Piso 1", identifier: "1", sort_order: 2 },
    { id: "p1", name: "Planta Baja", identifier: "PB", sort_order: 1 },
    { id: "p3", name: "Terraza", identifier: null, sort_order: 3 },
  ],
  unidades: [
    { id: "u1", floor_id: "p1", code: "PB-01", name: null, unit_type: "Departamento", room_count: 2, sort_order: 1 },
    { id: "u2", floor_id: "p2", code: "1A", name: null, unit_type: "Departamento", room_count: 3, sort_order: 2 },
    { id: "u3", floor_id: "p2", code: "1B", name: null, unit_type: "Oficina", room_count: null, sort_order: 1 },
  ],
  rubros: [
    { id: "r1", weight_percent: 50 },
    { id: "r2", weight_percent: null },
  ],
  tareas: [
    { id: "t1", rubro_id: "r1" },
    { id: "t2", rubro_id: "r2" },
  ],
  tareasPorUnidad: new Map(),
  avances: [
    { unit_id: "u1", task_id: "t1", status: "approved", submitted_at: haceDias(2) },
    { unit_id: "u1", task_id: "t2", status: "approved", submitted_at: haceDias(20) },
    { unit_id: "u2", task_id: "t1", status: "approved", submitted_at: haceDias(1) },
    { unit_id: "u3", task_id: "t1", status: "rejected", submitted_at: haceDias(3) },
  ],
  unidadesPermitidas: null,
  ahora,
};

describe("calcularResumen", () => {
  const resumen = calcularResumen(base);

  it("ordena pisos y unidades y saca los pisos sin unidades", () => {
    expect(resumen.pisos.map((p) => p.nombre)).toEqual(["Planta Baja", "Piso 1"]);
    expect(resumen.pisos[1]!.unidades.map((u) => u.codigo)).toEqual(["1B", "1A"]);
  });

  it("calcula el avance de unidad, piso y obra como la app", () => {
    expect(resumen.pisos[0]!.unidades[0]!.avance).toBe(100);
    expect(resumen.pisos[1]!.avance).toBe(25); // 1B 0 y 1A 50
    expect(resumen.numeros.avance).toBe(62.5); // promedio de pisos: 100 y 25
    expect(resumen.numeros.terminadas).toBe(1);
  });

  it("cuenta certificadas, las de la semana y las bloqueadas", () => {
    expect(resumen.numeros.certificadas).toBe(3);
    expect(resumen.numeros.certificadasEstaSemana).toBe(2);
    expect(resumen.numeros.bloqueadas).toBe(1);
    expect(resumen.pisos[1]!.unidades[0]!.bloqueada).toBe(true);
  });

  it("con unidades permitidas solo muestra esas", () => {
    const soloU2 = calcularResumen({ ...base, unidadesPermitidas: ["u2"] });
    expect(soloU2.numeros.unidades).toBe(1);
    expect(soloU2.numeros.certificadas).toBe(1);
    expect(soloU2.pisos.map((p) => p.id)).toEqual(["p2"]);
  });

  it("con tareas asignadas, cada unidad cuenta solo las suyas", () => {
    const asignadas = calcularResumen({ ...base, tareasPorUnidad: new Map([["u1", ["t1"]], ["u2", ["t1"]], ["u3", ["t2"]]]) });
    expect(asignadas.pisos[0]!.unidades[0]!.avance).toBe(50); // u1 solo tiene t1 (rubro de 50%): como la app, el otro rubro no suma
    expect(asignadas.numeros.bloqueadas).toBe(0); // el rechazo de u3 es de t1, que no tiene asignada
  });
});
