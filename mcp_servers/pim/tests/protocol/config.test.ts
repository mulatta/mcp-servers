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
  const account = {
    PIM_USERNAME: "tester",
    PIM_PASSWORD_FILE: "/run/credentials/pim/password",
  };

  test("reads the origin, the login name and the password file", () => {
    expect(
      readServer({ PIM_SERVER_URL: "https://mail.example.test", ...account }),
    ).toEqual({
      origin: "https://mail.example.test",
      username: "tester",
      passwordFile: "/run/credentials/pim/password",
    });
  });

  test("refuses a missing or unusable login name or password file", () => {
    const url = { PIM_SERVER_URL: "https://mail.example.test" };
    for (const env of [
      { ...url, PIM_PASSWORD_FILE: "/p" },
      { ...url, PIM_USERNAME: "tester" },
      // Basic authentication splits the login name at the first colon.
      { ...url, PIM_USERNAME: "a:b", PIM_PASSWORD_FILE: "/p" },
      { ...url, PIM_USERNAME: "a\nb", PIM_PASSWORD_FILE: "/p" },
      { ...url, PIM_USERNAME: "x".repeat(257), PIM_PASSWORD_FILE: "/p" },
    ])
      expect(code(() => readServer(env))).toBe("INVALID_ACCOUNT");
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
      expect(code(() => readServer({ PIM_SERVER_URL: url, ...account }))).toBe(
        "INVALID_SERVER",
      );
    expect(
      readServer({ PIM_SERVER_URL: "http://127.0.0.1:8080", ...account })
        .origin,
    ).toBe("http://127.0.0.1:8080");
    expect(
      readServer({ PIM_SERVER_URL: "http://localhost:8080/", ...account })
        .origin,
    ).toBe("http://localhost:8080");
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
