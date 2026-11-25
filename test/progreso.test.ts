import { describe, expect, it } from "vitest";
import { avanceDeInicio, avanceDeObra, pesosDeRubros, type EstructuraDeObra } from "../src/dominio/progreso";

const obra: EstructuraDeObra = {
  unidadesPorPiso: [["u1"], ["u2"]],
  tareas: [
    { id: "t1", rubro_id: "r1" },
    { id: "t2", rubro_id: "r1" },
    { id: "t3", rubro_id: "r2" },
  ],
  rubros: [
    { id: "r1", weight_percent: 60 },
    { id: "r2", weight_percent: null },
  ],
  tareasPorUnidad: new Map(),
};

describe("pesosDeRubros", () => {
  it("los automáticos se reparten lo que dejan los manuales", () => {
    const pesos = pesosDeRubros(obra.rubros);
    expect(pesos.get("r1")).toBe(60);
    expect(pesos.get("r2")).toBe(40);
  });
});

describe("avanceDeObra", () => {
  it("sin avances es 0", () => {
    expect(avanceDeObra(obra, [])).toBe(0);
  });

  it("solo suma lo certificado, y vale el último avance de cada tarea", () => {
    const avances = [
      // u1: t1 certificada → 60 * 1/2 = 30
      { unit_id: "u1", task_id: "t1", status: "approved", submitted_at: "2026-01-01T00:00:00Z" },
      // u1: t2 cargada sin certificar → no suma
      { unit_id: "u1", task_id: "t2", status: "pending", submitted_at: "2026-01-02T00:00:00Z" },
      // u2: t3 certificada y después vuelta a cargar → deja de sumar
      { unit_id: "u2", task_id: "t3", status: "approved", submitted_at: "2026-01-01T00:00:00Z" },
      { unit_id: "u2", task_id: "t3", status: "pending", submitted_at: "2026-01-03T00:00:00Z" },
    ];
    // u1 = 30, u2 = 0 → promedio de pisos = 15
    expect(avanceDeObra(obra, avances)).toBe(15);
  });

  it("con asignaciones, cada unidad cuenta solo sus tareas", () => {
    const conAsignaciones = { ...obra, unidadesPorPiso: [["u1"]], tareasPorUnidad: new Map([["u1", ["t3"]]]) };
    const avances = [{ unit_id: "u1", task_id: "t3", status: "approved", submitted_at: "2026-01-01T00:00:00Z" }];
    expect(avanceDeObra(conAsignaciones, avances)).toBe(40);
  });
});

describe("avanceDeInicio", () => {
  it("lo semanal es la diferencia con hace 7 días", () => {
    const ahora = new Date("2026-01-20T00:00:00Z");
    const avances = [
      { unit_id: "u1", task_id: "t3", status: "approved", submitted_at: "2026-01-01T00:00:00Z" },
      { unit_id: "u2", task_id: "t3", status: "approved", submitted_at: "2026-01-18T00:00:00Z" },
    ];
    const r = avanceDeInicio(obra, avances, ahora);
    expect(r.general).toBe(40);
    expect(r.semanal).toBe(20);
  });
});
