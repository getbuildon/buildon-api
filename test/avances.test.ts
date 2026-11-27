import { describe, expect, it } from "vitest";
import { cuerpoDeAvance, horaDeCarga } from "../src/rutas/avances";

const ahora = new Date("2026-11-26T12:00:00Z");

describe("horaDeCarga", () => {
  it("usa la hora del dispositivo si es razonable (lo cargado sin señal conserva su hora)", () => {
    expect(horaDeCarga("2026-11-25T09:30:00-03:00", ahora)).toBe("2026-11-25T12:30:00.000Z");
  });
  it("con el reloj roto (futuro o muy viejo) usa la del servidor", () => {
    expect(horaDeCarga("2027-01-01T00:00:00Z", ahora)).toBe(ahora.toISOString());
    expect(horaDeCarga("2020-01-01T00:00:00Z", ahora)).toBe(ahora.toISOString());
  });
});

describe("cuerpoDeAvance", () => {
  const id = (n: number) => `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;
  const valido = {
    hechoEn: "2026-11-26T09:00:00-03:00",
    pisoId: id(1),
    rubroId: id(2),
    tareas: [{ tareaId: id(3), estado: "completed", comentario: null, unidades: [{ unidadId: id(4), avanceId: id(5) }] }],
  };
  it("acepta un envío completo", () => {
    expect(cuerpoDeAvance.safeParse(valido).success).toBe(true);
  });
  it("rechaza «pendiente» (no se guarda) y tareas sin unidades", () => {
    expect(cuerpoDeAvance.safeParse({ ...valido, tareas: [{ ...valido.tareas[0], estado: "pending" }] }).success).toBe(false);
    expect(cuerpoDeAvance.safeParse({ ...valido, tareas: [{ ...valido.tareas[0], unidades: [] }] }).success).toBe(false);
  });
});
