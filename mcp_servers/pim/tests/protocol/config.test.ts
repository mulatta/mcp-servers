import { describe, expect, test } from "bun:test";
import {
  ConfigError,
  readServer,
  readTransport,
  readWrites,
  writeGroups,
} from "../../src/config.ts";

const code = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof ConfigError ? error.code : "other";
  }
  return "none";
};

describe("server configuration", () => {
  test("reads the origin, client and state directory", () => {
    expect(
      readServer({
        PIM_SERVER_URL: "https://mail.example.test",
        PIM_STATE_DIR: "/var/lib/pim",
      }),
    ).toEqual({
      origin: "https://mail.example.test",
      clientId: "pim-mcp",
      stateDir: "/var/lib/pim",
    });
  });

  test("falls back to systemd and XDG state directories", () => {
    const base = { PIM_SERVER_URL: "https://mail.example.test" };
    expect(
      readServer({ ...base, STATE_DIRECTORY: "/var/lib/a:/var/lib/b" })
        .stateDir,
    ).toBe("/var/lib/a");
    expect(readServer({ ...base, XDG_STATE_HOME: "/x" }).stateDir).toBe(
      "/x/pim-mcp",
    );
    expect(readServer({ ...base, HOME: "/home/u" }).stateDir).toBe(
      "/home/u/.local/state/pim-mcp",
    );
  });

  test("accepts only a bare HTTPS origin, or HTTP on loopback", () => {
    for (const url of [
      "",
      "ftp://mail.example.test",
      "http://mail.example.test",
      "https://user:pw@mail.example.test",
      "https://mail.example.test/jmap",
      "https://mail.example.test/?a=1",
    ])
      expect(code(() => readServer({ PIM_SERVER_URL: url, HOME: "/h" }))).toBe(
        "INVALID_SERVER",
      );
    expect(
      readServer({ PIM_SERVER_URL: "http://127.0.0.1:8080", HOME: "/h" })
        .origin,
    ).toBe("http://127.0.0.1:8080");
    expect(
      readServer({ PIM_SERVER_URL: "http://localhost:8080/", HOME: "/h" })
        .origin,
    ).toBe("http://localhost:8080");
  });

  test("rejects a client ID with unexpected characters", () => {
    expect(
      code(() =>
        readServer({
          PIM_SERVER_URL: "https://mail.example.test",
          PIM_CLIENT_ID: "a b",
          HOME: "/h",
        }),
      ),
    ).toBe("INVALID_SERVER");
  });
});

describe("write groups", () => {
  test("unset or empty is read-only", () => {
    expect(readWrites({}).size).toBe(0);
    expect(readWrites({ PIM_WRITES: "" }).size).toBe(0);
  });

  test("all enables every group", () => {
    expect([...readWrites({ PIM_WRITES: "all" })]).toEqual([...writeGroups]);
  });

  test("named groups are enabled exactly", () => {
    expect([...readWrites({ PIM_WRITES: "flag, send" })]).toEqual([
      "flag",
      "send",
    ]);
  });

  test("unknown or mixed tokens refuse to start", () => {
    for (const value of ["flags", "all,flag", "flag,,send"])
      expect(code(() => readWrites({ PIM_WRITES: value }))).toBe(
        "INVALID_WRITES",
      );
  });
});

describe("transport", () => {
  test("defaults to stdio", () => {
    expect(readTransport({})).toEqual({ kind: "stdio" });
  });

  test("HTTP needs a port and a token file", () => {
    expect(
      readTransport({
        PIM_TRANSPORT: "http",
        PIM_HTTP_PORT: "8766",
        PIM_HTTP_TOKEN_FILE: "/run/token",
      }),
    ).toEqual({
      kind: "http",
      hostname: "127.0.0.1",
      port: 8766,
      tokenFile: "/run/token",
      allowedHosts: ["localhost", "127.0.0.1"],
    });
    expect(code(() => readTransport({ PIM_TRANSPORT: "http" }))).toBe(
      "INVALID_HTTP_CONFIG",
    );
    expect(code(() => readTransport({ PIM_TRANSPORT: "ws" }))).toBe(
      "INVALID_TRANSPORT",
    );
  });
});
