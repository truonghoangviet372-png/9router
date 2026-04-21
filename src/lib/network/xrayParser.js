function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function normalizeKey(value) {
  return normalizeString(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseBoolean(value) {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return false;
  return null;
}

function parseCsv(value) {
  return normalizeString(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePort(value, fieldName = "Port") {
  const num = Number(normalizeString(value));
  if (!Number.isInteger(num) || num < 1 || num > 65535) {
    return { error: `${fieldName} must be between 1 and 65535` };
  }
  return { value: num };
}

function parseKeyValueBlock(text) {
  const map = {};
  const lines = normalizeString(text).split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const index = line.indexOf(":");
    if (index <= 0) continue;
    const key = normalizeKey(line.slice(0, index));
    const value = line.slice(index + 1).trim();
    if (!key) continue;
    map[key] = value;
  }

  return map;
}

function parseTransportSecurity(fields, protocol) {
  const rawSecurity = normalizeString(fields.security).toLowerCase();
  const rawTls = normalizeString(fields.tls).toLowerCase();

  if (protocol === "vmess") {
    if (rawTls === "tls" || rawTls === "reality") return rawTls;
    if (parseBoolean(rawTls) === true) return "tls";
    if (rawSecurity === "tls" || rawSecurity === "reality") return rawSecurity;
    return "";
  }

  if (rawSecurity === "tls" || rawSecurity === "reality") return rawSecurity;
  if (rawSecurity === "none") return "";
  if (protocol === "trojan") return "tls";
  return "";
}

function buildStreamSettings(fields, protocol) {
  const network = normalizeString(fields.network).toLowerCase() || "tcp";
  const streamSettings = { network };
  const transportSecurity = parseTransportSecurity(fields, protocol);

  if (transportSecurity === "tls") {
    streamSettings.security = "tls";
    const tlsSettings = {};
    const serverName = normalizeString(fields.sni);
    const alpn = parseCsv(fields.alpn);

    if (serverName) tlsSettings.serverName = serverName;
    if (alpn.length > 0) tlsSettings.alpn = alpn;
    if (Object.keys(tlsSettings).length > 0) {
      streamSettings.tlsSettings = tlsSettings;
    }
  } else if (transportSecurity === "reality") {
    streamSettings.security = "reality";
    const realitySettings = {};
    const serverName = normalizeString(fields.sni);
    const alpn = parseCsv(fields.alpn);
    const fingerprint = normalizeString(fields.fingerprint);
    const publicKey = normalizeString(fields.realitypublickey);
    const shortId = normalizeString(fields.realityshortid);

    if (serverName) realitySettings.serverName = serverName;
    if (fingerprint) realitySettings.fingerprint = fingerprint;
    if (publicKey) realitySettings.publicKey = publicKey;
    if (shortId) realitySettings.shortId = shortId;
    if (alpn.length > 0) realitySettings.alpn = alpn;
    if (Object.keys(realitySettings).length > 0) {
      streamSettings.realitySettings = realitySettings;
    }
  }

  if (network === "ws") {
    const path = normalizeString(fields.path) || "/";
    const hostHeader = normalizeString(fields.hostheader || fields.host);
    streamSettings.wsSettings = hostHeader
      ? { path, headers: { Host: hostHeader } }
      : { path };
  } else if (network === "grpc") {
    const serviceName = normalizeString(fields.servicename);
    if (serviceName) {
      streamSettings.grpcSettings = { serviceName };
    }
  }

  return streamSettings;
}

function buildTrojanOutbound(fields) {
  const address = normalizeString(fields.server || fields.address || fields.host);
  if (!address) return { error: "Server is required for Trojan" };

  const portParsed = parsePort(fields.port, "Port");
  if (portParsed.error) return { error: portParsed.error };

  const password = normalizeString(fields.password);
  if (!password) return { error: "Password is required for Trojan" };

  const server = {
    address,
    port: portParsed.value,
    password,
  };

  const flow = normalizeString(fields.flow).toLowerCase();
  if (flow && flow !== "none") {
    server.flow = flow;
  }

  return {
    outbound: {
      protocol: "trojan",
      settings: { servers: [server] },
      streamSettings: buildStreamSettings(fields, "trojan"),
    },
    meta: {
      protocol: "trojan",
      server: address,
      port: portParsed.value,
      remark: normalizeString(fields.remark),
    },
  };
}

function buildVmessOutbound(fields) {
  const address = normalizeString(fields.server || fields.address || fields.host);
  if (!address) return { error: "Server is required for VMess" };

  const portParsed = parsePort(fields.port, "Port");
  if (portParsed.error) return { error: portParsed.error };

  const uuid = normalizeString(fields.uuid || fields.id);
  if (!uuid) return { error: "UUID is required for VMess" };

  const alterIdValue = Number(normalizeString(fields.alterid || "0"));
  const securityRaw = normalizeString(fields.security).toLowerCase();
  const userSecurity = securityRaw && !["tls", "reality", "none"].includes(securityRaw) ? securityRaw : "auto";

  return {
    outbound: {
      protocol: "vmess",
      settings: {
        vnext: [
          {
            address,
            port: portParsed.value,
            users: [
              {
                id: uuid,
                alterId: Number.isFinite(alterIdValue) ? alterIdValue : 0,
                security: userSecurity || "auto",
              },
            ],
          },
        ],
      },
      streamSettings: buildStreamSettings(fields, "vmess"),
    },
    meta: {
      protocol: "vmess",
      server: address,
      port: portParsed.value,
      remark: normalizeString(fields.remark),
    },
  };
}

function buildVlessOutbound(fields) {
  const address = normalizeString(fields.server || fields.address || fields.host);
  if (!address) return { error: "Server is required for VLESS" };

  const portParsed = parsePort(fields.port, "Port");
  if (portParsed.error) return { error: portParsed.error };

  const uuid = normalizeString(fields.uuid || fields.id);
  if (!uuid) return { error: "UUID is required for VLESS" };

  const user = {
    id: uuid,
    encryption: normalizeString(fields.encryption).toLowerCase() || "none",
  };

  const flow = normalizeString(fields.flow).toLowerCase();
  if (flow && flow !== "none") {
    user.flow = flow;
  }

  return {
    outbound: {
      protocol: "vless",
      settings: {
        vnext: [
          {
            address,
            port: portParsed.value,
            users: [user],
          },
        ],
      },
      streamSettings: buildStreamSettings(fields, "vless"),
    },
    meta: {
      protocol: "vless",
      server: address,
      port: portParsed.value,
      remark: normalizeString(fields.remark),
    },
  };
}

function buildShadowsocksOutbound(fields) {
  const address = normalizeString(fields.server || fields.address || fields.host);
  if (!address) return { error: "Server is required for Shadowsocks" };

  const portParsed = parsePort(fields.port, "Port");
  if (portParsed.error) return { error: portParsed.error };

  const method = normalizeString(fields.method);
  if (!method) return { error: "Method is required for Shadowsocks" };

  const password = normalizeString(fields.password);
  if (!password) return { error: "Password is required for Shadowsocks" };

  return {
    outbound: {
      protocol: "shadowsocks",
      settings: {
        servers: [
          {
            address,
            port: portParsed.value,
            method,
            password,
          },
        ],
      },
    },
    meta: {
      protocol: "shadowsocks",
      server: address,
      port: portParsed.value,
      remark: normalizeString(fields.remark),
    },
  };
}

export function buildXrayPoolConfigFromText(rawText) {
  const fields = parseKeyValueBlock(rawText);
  const type = normalizeString(fields.type).toLowerCase();

  if (!type) {
    return { error: "Missing Type field in Xray config text" };
  }

  let parsed;
  if (type === "trojan") {
    parsed = buildTrojanOutbound(fields);
  } else if (type === "vmess") {
    parsed = buildVmessOutbound(fields);
  } else if (type === "vless") {
    parsed = buildVlessOutbound(fields);
  } else if (type === "shadowsocks" || type === "ss") {
    parsed = buildShadowsocksOutbound(fields);
  } else {
    return { error: `Unsupported Xray type: ${type}` };
  }

  if (parsed.error) {
    return { error: parsed.error };
  }

  const protocol = parsed.meta?.protocol || type;
  const server = normalizeString(parsed.meta?.server) || "node";
  const port = parsed.meta?.port || 0;

  return {
    xrayOutbound: parsed.outbound,
    xrayMeta: {
      ...parsed.meta,
      sourceType: type,
    },
    proxyUrl: `xray://${protocol}@${server}:${port}`,
    suggestedName: normalizeString(parsed.meta?.remark),
  };
}

export function splitXrayConfigBlocks(rawText) {
  const text = normalizeString(rawText);
  if (!text) return [];

  const blocks = text
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter(Boolean);

  if (blocks.some((block) => /^type\s*:/im.test(block))) {
    return blocks.filter((block) => /^type\s*:/im.test(block));
  }

  return blocks;
}
