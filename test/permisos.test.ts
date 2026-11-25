import { describe, expect, it } from "vitest";
import { resolverAcceso } from "../src/permisos";
import { origenesPermitidos } from "../src/navegador";
import { esLectura } from "../src/reintento";

describe("resolverAcceso (espejo de la app y de la RLS)", () => {
  it("sin ninguna capa no hay acceso", () => {
    expect(resolverAcceso({ tipoEnObra: null, adminDeEmpresa: false, unidadesDeCliente: [] })).toBeNull();
  });

  it("operador carga pero no certifica ni configura", () => {
    const a = resolverAcceso({ tipoEnObra: "operador", adminDeEmpresa: false, unidadesDeCliente: [] })!;
    expect(a.permisos.loadProgress).toBe(true);
    expect(a.permisos.certifyTasks).toBe(false);
    expect(a.permisos.configureProject).toBe(false);
    expect(a.unidades).toBeNull();
  });

  it("supervisor certifica", () => {
    const a = resolverAcceso({ tipoEnObra: "supervisor", adminDeEmpresa: false, unidadesDeCliente: [] })!;
    expect(a.permisos.certifyTasks).toBe(true);
  });

  it("admin de empresa configura pero no carga ni certifica", () => {
    const a = resolverAcceso({ tipoEnObra: null, adminDeEmpresa: true, unidadesDeCliente: [] })!;
    expect(a.tipo).toBe("admin");
    expect(a.permisos.configureProject).toBe(true);
    expect(a.permisos.loadProgress).toBe(false);
    expect(a.permisos.certifyTasks).toBe(false);
  });

  it("supervisor que además es admin de empresa une las dos capas", () => {
    const a = resolverAcceso({ tipoEnObra: "supervisor", adminDeEmpresa: true, unidadesDeCliente: [] })!;
    expect(a.permisos.configureProject).toBe(true);
    expect(a.permisos.certifyTasks).toBe(true);
  });

  it("cliente ve solo sus unidades y el portal", () => {
    const a = resolverAcceso({ tipoEnObra: null, adminDeEmpresa: false, unidadesDeCliente: ["u1"] })!;
    expect(a.tipo).toBe("cliente");
    expect(a.permisos.clientPortal).toBe(true);
    expect(a.permisos.loadProgress).toBe(false);
    expect(a.unidades).toEqual(["u1"]);
  });
});

describe("origenesPermitidos", () => {
  it("producción no acepta test ni local aunque la variable lo diga", () => {
    const o = origenesPermitidos({ BUILDON_ENV: "produccion", APP_PUBLIC_URL: "https://test.getbuildon.com" });
    expect(o.has("https://getbuildon.com")).toBe(true);
    expect(o.has("https://test.getbuildon.com")).toBe(false);
    expect(o.has("http://localhost:3000")).toBe(false);
  });

  it("test acepta su dominio y el local", () => {
    const o = origenesPermitidos({ BUILDON_ENV: "test", APP_PUBLIC_URL: "https://test.getbuildon.com" });
    expect(o.has("https://test.getbuildon.com")).toBe(true);
    expect(o.has("http://localhost:3000")).toBe(true);
    expect(o.has("https://getbuildon.com")).toBe(false);
  });
});

describe("esLectura", () => {
  it("GET es lectura, un insert no", () => {
    expect(esLectura("https://x.supabase.co/rest/v1/projects", "GET")).toBe(true);
    expect(esLectura("https://x.supabase.co/rest/v1/progress_entries", "POST")).toBe(false);
    expect(esLectura("https://x.supabase.co/rest/v1/rpc/latest_progress_entries", "POST")).toBe(true);
  });
});
