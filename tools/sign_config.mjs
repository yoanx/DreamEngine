#!/usr/bin/env node
/* 从环境变量解析可选的 Windows 代码签名参数。
 *
 * 设计原则：没有配置任何签名环境变量时返回空数组，构建行为与之前完全一致
 * （不签名、不报错），只是多打一行提示。这样本地、CI、他人复刻都不会因为
 * 缺证书而构建失败。
 *
 * 支持三条路径，按优先级取第一条可用的：
 *   1. azure   —— Azure 工件签名（原 Trusted Signing），云端 HSM，无需 UKey
 *   2. pfx     —— 导出型证书文件（.pfx/.p12），CI 也能用
 *   3. subject —— 硬件 UKey / 已装入证书存储的证书，只能本机签名
 */

const AZURE_FIELDS = [
  ["AZURE_PUBLISHER", "publisherName"],
  ["AZURE_ENDPOINT", "endpoint"],
  ["AZURE_ACCOUNT", "codeSigningAccountName"],
  ["AZURE_PROFILE", "certificateProfileName"],
];

function has(env, key) {
  return typeof env[key] === "string" && env[key].trim() !== "";
}

export function resolveSignArgs(env = process.env) {
  const azureCredentials = has(env, "AZURE_TENANT_ID") && has(env, "AZURE_CLIENT_ID") && has(env, "AZURE_CLIENT_SECRET");
  const azureConfig = AZURE_FIELDS.every(([from]) => has(env, from));

  if (azureCredentials && azureConfig) {
    const args = ["--config.win.azureSignOptions.publisherName", env.AZURE_PUBLISHER];
    for (const [from, to] of AZURE_FIELDS.slice(1)) {
      args.push(`--config.win.azureSignOptions.${to}`, env[from]);
    }
    return { mode: "azure", args, note: `Azure 工件签名（${env.AZURE_ACCOUNT} / ${env.AZURE_PROFILE}）` };
  }

  if (has(env, "WIN_CSC_LINK")) {
    // electron-builder 原生识别 WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD，无需额外参数；
    // 这里只回报模式，避免重复注入。
    return {
      mode: "pfx",
      args: [],
      note: has(env, "WIN_CSC_KEY_PASSWORD") ? "证书文件签名（WIN_CSC_LINK）" : "证书文件签名（WIN_CSC_LINK，缺 WIN_CSC_KEY_PASSWORD）",
    };
  }

  if (has(env, "WIN_CERTIFICATE_SUBJECT")) {
    return {
      mode: "subject",
      args: ["--config.win.certificateSubjectName", env.WIN_CERTIFICATE_SUBJECT],
      note: `证书存储签名（${env.WIN_CERTIFICATE_SUBJECT}），需 UKey 已插入`,
    };
  }

  return {
    mode: "none",
    args: [],
    note: "未配置签名凭据，构建未签名安装包（SmartScreen 会提示未知发布者）",
  };
}
