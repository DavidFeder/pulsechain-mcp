/**
 * Expanded fork-vs-bridged origin catalog — drives shipped resolve + labels.
 * Includes e-star/p-star naming, pHEX preferred exception, eUSDC/eUSDT/eWBTC/pWBTC.
 */
import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import {
  BRIDGED_DAI_ADDRESS,
  BRIDGED_WETH_ADDRESS,
  CORE_TOKENS,
  EHEX_ADDRESS,
  EHEX_IDENTITY,
  EHEX_MAJOR_PAIR_ADDRESS,
  EP_NAMING_RULES,
  EUSDC_MAJOR_PAIR_ADDRESS,
  EUSDT_MAJOR_PAIR_ADDRESS,
  EWBTC_ADDRESS,
  FORK_DAI_ADDRESS,
  FORK_USDT_ADDRESS,
  FORK_WETH_ADDRESS,
  HEX_ADDRESS,
  PHEX_IDENTITY,
  PWBTC_ADDRESS,
  TOKEN_ORIGIN_GUIDANCE,
  RO_RESEARCH_GUIDANCE,
  USDC_FROM_ETH_ADDRESS,
  USDT_FROM_ETH_ADDRESS,
  getTokenIdentityLabel,
  resolveCoreToken,
  tokenLabelFields,
} from "../src/constants.js";
import { resolveTokenAddress } from "../src/tools/chain/operations.js";

describe("HEX / pHEX vs eHEX (shipped)", () => {
  it("checksums are valid EIP-55", () => {
    expect(HEX_ADDRESS).toBe(getAddress(HEX_ADDRESS));
    expect(EHEX_ADDRESS).toBe(getAddress(EHEX_ADDRESS));
    expect(HEX_ADDRESS.toLowerCase()).not.toBe(EHEX_ADDRESS.toLowerCase());
  });

  it("HEX and PHEX resolve to state-fork pHEX only", () => {
    for (const sym of ["HEX", "PHEX", "phex", "P_HEX"]) {
      const t = resolveCoreToken(sym);
      expect(t?.address.toLowerCase()).toBe(HEX_ADDRESS.toLowerCase());
      expect(t?.origin).toBe("state_fork");
      expect(t?.displaySymbol).toBe("pHEX");
    }
    expect(resolveTokenAddress("HEX").toLowerCase()).toBe(
      HEX_ADDRESS.toLowerCase(),
    );
    expect(resolveTokenAddress("PHEX").toLowerCase()).toBe(
      HEX_ADDRESS.toLowerCase(),
    );
  });

  it("EHEX resolves only to bridged eHEX (never pHEX address)", () => {
    for (const sym of ["EHEX", "ehex", "BRIDGED_HEX", "E_HEX"]) {
      const t = resolveCoreToken(sym);
      expect(t?.address.toLowerCase()).toBe(EHEX_ADDRESS.toLowerCase());
      expect(t?.origin).toBe("bridged");
      expect(t?.displaySymbol).toBe("eHEX");
    }
    expect(resolveTokenAddress("EHEX").toLowerCase()).toBe(
      EHEX_ADDRESS.toLowerCase(),
    );
    expect(resolveTokenAddress("EHEX").toLowerCase()).not.toBe(
      HEX_ADDRESS.toLowerCase(),
    );
  });

  it("labels pHEX and eHEX with cross-references", () => {
    const phex = getTokenIdentityLabel(HEX_ADDRESS)!;
    expect(phex.isPhex).toBe(true);
    expect(phex.isEhex).toBe(false);
    expect(phex.origin).toBe("state_fork");
    expect(phex.identityNote).toBe(PHEX_IDENTITY);
    expect(phex.displaySymbol).toBe("pHEX");

    const pFields = tokenLabelFields(HEX_ADDRESS)!;
    expect(pFields.is_phex).toBe(true);
    expect(pFields.ehex_address).toBe(EHEX_ADDRESS);
    expect(String(pFields.warning)).toMatch(/eHEX|0x57fd/i);

    const ehex = getTokenIdentityLabel(EHEX_ADDRESS)!;
    expect(ehex.isEhex).toBe(true);
    expect(ehex.isPhex).toBe(false);
    expect(ehex.origin).toBe("bridged");
    expect(ehex.identityNote).toBe(EHEX_IDENTITY);

    const eFields = tokenLabelFields(EHEX_ADDRESS)!;
    expect(eFields.is_ehex).toBe(true);
    expect(eFields.is_bridged_hex).toBe(true);
    expect(eFields.phex_address).toBe(HEX_ADDRESS);
    expect(eFields.bridge_url).toBe("https://bridge.pulsechain.com");
  });

  it("CORE_TOKENS.HEX is state fork; eHEX is not a default core key", () => {
    expect(CORE_TOKENS.HEX!.address.toLowerCase()).toBe(
      HEX_ADDRESS.toLowerCase(),
    );
    expect(
      Object.values(CORE_TOKENS).some(
        (t) => t.address.toLowerCase() === EHEX_ADDRESS.toLowerCase(),
      ),
    ).toBe(false);
  });
});

describe("USDT / WETH bridged vs fork (shipped)", () => {
  it("USDT symbol is bridged eUSDT only; FUSDT is state fork", () => {
    const usdt = resolveCoreToken("USDT")!;
    expect(usdt.address.toLowerCase()).toBe(USDT_FROM_ETH_ADDRESS.toLowerCase());
    expect(usdt.origin).toBe("bridged");
    expect(usdt.displaySymbol).toBe("eUSDT");
    expect(usdt.isRealStablecoin).toBe(true);

    for (const sym of ["EUSDT", "eUSDT", "BRIDGED_USDT"]) {
      expect(resolveCoreToken(sym)?.address.toLowerCase()).toBe(
        USDT_FROM_ETH_ADDRESS.toLowerCase(),
      );
    }

    const fusdt = resolveCoreToken("FUSDT")!;
    expect(fusdt.address.toLowerCase()).toBe(FORK_USDT_ADDRESS.toLowerCase());
    expect(fusdt.origin).toBe("state_fork");
    expect(fusdt.isRealStablecoin).toBe(false);
    expect(resolveTokenAddress("FORK_USDT").toLowerCase()).toBe(
      FORK_USDT_ADDRESS.toLowerCase(),
    );
  });

  it("WETH symbol is bridged only; FWETH is state fork", () => {
    const weth = resolveCoreToken("WETH")!;
    expect(weth.address.toLowerCase()).toBe(BRIDGED_WETH_ADDRESS.toLowerCase());
    expect(weth.origin).toBe("bridged");

    const fweth = resolveCoreToken("FWETH")!;
    expect(fweth.address.toLowerCase()).toBe(FORK_WETH_ADDRESS.toLowerCase());
    expect(fweth.origin).toBe("state_fork");
    expect(resolveTokenAddress("FORK_WETH").toLowerCase()).toBe(
      FORK_WETH_ADDRESS.toLowerCase(),
    );
  });

  it("label fields mark bridged vs forked USDT/WETH", () => {
    const bUsdt = tokenLabelFields(USDT_FROM_ETH_ADDRESS)!;
    expect(bUsdt.is_bridged_usdt).toBe(true);
    expect(bUsdt.is_eusdt).toBe(true);
    expect(bUsdt.display_symbol).toBe("eUSDT");
    expect(bUsdt.fork_usdt_address).toBe(FORK_USDT_ADDRESS);

    const fUsdt = tokenLabelFields(FORK_USDT_ADDRESS)!;
    expect(fUsdt.is_fork_usdt).toBe(true);
    expect(fUsdt.do_not_treat_as_usd_stable).toBe(true);
    expect(fUsdt.bridged_usdt_address).toBe(USDT_FROM_ETH_ADDRESS);

    const bWeth = tokenLabelFields(BRIDGED_WETH_ADDRESS)!;
    expect(bWeth.is_bridged_weth).toBe(true);
    expect(bWeth.fork_weth_address).toBe(FORK_WETH_ADDRESS);

    const fWeth = tokenLabelFields(FORK_WETH_ADDRESS)!;
    expect(fWeth.is_fork_weth).toBe(true);
    expect(fWeth.bridged_weth_address).toBe(BRIDGED_WETH_ADDRESS);
  });

  it("fork addresses have valid EIP-55 checksums", () => {
    expect(FORK_USDT_ADDRESS).toBe(getAddress(FORK_USDT_ADDRESS));
    expect(FORK_WETH_ADDRESS).toBe(getAddress(FORK_WETH_ADDRESS));
    expect(BRIDGED_WETH_ADDRESS).toBe(getAddress(BRIDGED_WETH_ADDRESS));
    expect(USDT_FROM_ETH_ADDRESS).toBe(getAddress(USDT_FROM_ETH_ADDRESS));
  });
});

describe("eUSDC / eWBTC / pWBTC (shipped origin catalog)", () => {
  it("USDC / EUSDC resolve to bridged eUSDC only", () => {
    for (const sym of ["USDC", "EUSDC", "eUSDC", "BRIDGED_USDC"]) {
      const t = resolveCoreToken(sym)!;
      expect(t.address.toLowerCase()).toBe(USDC_FROM_ETH_ADDRESS.toLowerCase());
      expect(t.origin).toBe("bridged");
      expect(t.displaySymbol).toBe("eUSDC");
      expect(t.isRealStablecoin).toBe(true);
    }
    expect(resolveTokenAddress("USDC").toLowerCase()).toBe(
      USDC_FROM_ETH_ADDRESS.toLowerCase(),
    );
  });

  it("WBTC / EWBTC resolve to bridged eWBTC; PWBTC is bad fork", () => {
    for (const sym of ["WBTC", "EWBTC", "eWBTC", "BRIDGED_WBTC"]) {
      const t = resolveCoreToken(sym)!;
      expect(t.address.toLowerCase()).toBe(EWBTC_ADDRESS.toLowerCase());
      expect(t.origin).toBe("bridged");
      expect(t.displaySymbol).toBe("eWBTC");
    }
    for (const sym of ["PWBTC", "FORK_WBTC", "pWBTC"]) {
      const t = resolveCoreToken(sym)!;
      expect(t.address.toLowerCase()).toBe(PWBTC_ADDRESS.toLowerCase());
      expect(t.origin).toBe("state_fork");
      expect(t.displaySymbol).toBe("pWBTC");
    }
    expect(resolveCoreToken("WBTC")!.address.toLowerCase()).not.toBe(
      PWBTC_ADDRESS.toLowerCase(),
    );
  });

  it("label fields distinguish eUSDC, eWBTC, pWBTC", () => {
    const eusdc = tokenLabelFields(USDC_FROM_ETH_ADDRESS)!;
    expect(eusdc.token_origin).toBe("bridged");
    expect(eusdc.display_symbol).toBe("eUSDC");
    expect(eusdc.is_eusdc).toBe(true);
    expect(eusdc.is_bridged_usdc).toBe(true);

    const ewbtc = tokenLabelFields(EWBTC_ADDRESS)!;
    expect(ewbtc.token_origin).toBe("bridged");
    expect(ewbtc.display_symbol).toBe("eWBTC");
    expect(ewbtc.is_ewbtc).toBe(true);
    expect(ewbtc.pwbtc_address).toBe(PWBTC_ADDRESS);

    const pwbtc = tokenLabelFields(PWBTC_ADDRESS)!;
    expect(pwbtc.token_origin).toBe("state_fork");
    expect(pwbtc.display_symbol).toBe("pWBTC");
    expect(pwbtc.is_pwbtc).toBe(true);
    expect(pwbtc.typically_useless_fork).toBe(true);
    expect(pwbtc.do_not_prefer).toBe(true);
    expect(pwbtc.ewbtc_address).toBe(EWBTC_ADDRESS);
  });

  it("pHEX remains preferred state-fork exception; pWBTC is not preferred", () => {
    const phex = getTokenIdentityLabel(HEX_ADDRESS)!;
    expect(phex.isPhex).toBe(true);
    expect(phex.isPreferredStateFork).toBe(true);
    expect(tokenLabelFields(HEX_ADDRESS)!.preferred_hex_exception).toBe(true);
    expect(tokenLabelFields(HEX_ADDRESS)!.is_preferred_state_fork).toBe(true);

    const pwbtc = getTokenIdentityLabel(PWBTC_ADDRESS)!;
    expect(pwbtc.isPwbtc).toBe(true);
    expect(pwbtc.isPreferredStateFork).toBeUndefined();
    expect(tokenLabelFields(PWBTC_ADDRESS)!.preferred_hex_exception).toBeUndefined();
  });

  it("eUSDC / eWBTC / pWBTC / major pair addresses have valid EIP-55 checksums", () => {
    for (const a of [
      USDC_FROM_ETH_ADDRESS,
      EWBTC_ADDRESS,
      PWBTC_ADDRESS,
      EUSDC_MAJOR_PAIR_ADDRESS,
      EUSDT_MAJOR_PAIR_ADDRESS,
      EHEX_MAJOR_PAIR_ADDRESS,
    ]) {
      expect(a).toBe(getAddress(a));
    }
  });

  it("unknown addresses get no invented origin", () => {
    expect(
      tokenLabelFields("0x1111111111111111111111111111111111111111"),
    ).toBeNull();
    expect(
      getTokenIdentityLabel("0x1111111111111111111111111111111111111111"),
    ).toBeNull();
  });
});

describe("dual-DAI rules still hold after origin expansion", () => {
  it("plain DAI never resolves to fork address", () => {
    expect(resolveCoreToken("DAI")!.address.toLowerCase()).toBe(
      BRIDGED_DAI_ADDRESS.toLowerCase(),
    );
    expect(resolveCoreToken("DAI")!.address.toLowerCase()).not.toBe(
      FORK_DAI_ADDRESS.toLowerCase(),
    );
    expect(resolveTokenAddress("DAI").toLowerCase()).toBe(
      BRIDGED_DAI_ADDRESS.toLowerCase(),
    );
  });

  it("PDAI still resolves to forked pDAI", () => {
    expect(resolveTokenAddress("PDAI").toLowerCase()).toBe(
      FORK_DAI_ADDRESS.toLowerCase(),
    );
  });
});

describe("TOKEN_ORIGIN_GUIDANCE payload", () => {
  it("documents fork vs bridge pairs, e/p rules, and residual limits", () => {
    expect(TOKEN_ORIGIN_GUIDANCE.pairs.dai.bridged.address).toBe(
      BRIDGED_DAI_ADDRESS,
    );
    expect(TOKEN_ORIGIN_GUIDANCE.pairs.hex.stateFork.address).toBe(HEX_ADDRESS);
    expect(TOKEN_ORIGIN_GUIDANCE.pairs.hex.stateFork.preferred).toBe(true);
    expect(TOKEN_ORIGIN_GUIDANCE.pairs.hex.bridged.address).toBe(EHEX_ADDRESS);
    expect(TOKEN_ORIGIN_GUIDANCE.pairs.usdc.bridged.address).toBe(
      USDC_FROM_ETH_ADDRESS,
    );
    expect(TOKEN_ORIGIN_GUIDANCE.pairs.usdc.bridged.displaySymbol).toBe("eUSDC");
    expect(TOKEN_ORIGIN_GUIDANCE.pairs.wbtc.bridged.address).toBe(EWBTC_ADDRESS);
    expect(TOKEN_ORIGIN_GUIDANCE.pairs.wbtc.stateFork.address).toBe(
      PWBTC_ADDRESS,
    );
    expect(TOKEN_ORIGIN_GUIDANCE.pairs.wbtc.stateFork.preferred).toBe(false);
    expect(TOKEN_ORIGIN_GUIDANCE.knownMajorPairs.eUSDC.pairAddress).toBe(
      EUSDC_MAJOR_PAIR_ADDRESS,
    );
    // v0.1.36: stale eUSDC major 0x8C357BE2…976b was live pHEX/WPLS — must not return
    expect(
      TOKEN_ORIGIN_GUIDANCE.knownMajorPairs.eUSDC.pairAddress.toLowerCase(),
    ).not.toBe("0x8c357be2cf2c1de1c4dca8aea0af1529f789976b");
    expect(
      TOKEN_ORIGIN_GUIDANCE.knownMajorPairs.eUSDC.pairAddress.toLowerCase(),
    ).toBe("0x3225e3b0d3c6b97ec9848f7b40bb3030e5497709");
    expect(TOKEN_ORIGIN_GUIDANCE.knownMajorPairs.eUSDT.pairAddress).toBe(
      EUSDT_MAJOR_PAIR_ADDRESS,
    );
    expect(TOKEN_ORIGIN_GUIDANCE.knownMajorPairs.eHEX.pairAddress).toBe(
      EHEX_MAJOR_PAIR_ADDRESS,
    );
    expect(TOKEN_ORIGIN_GUIDANCE.bridgeUrl).toBe(
      "https://bridge.pulsechain.com",
    );
    expect(TOKEN_ORIGIN_GUIDANCE.epNamingRules).toEqual([...EP_NAMING_RULES]);
    expect(TOKEN_ORIGIN_GUIDANCE.rulesForAgents.join(" ")).toMatch(
      /e\*.*bridged|bridged.*e\*/i,
    );
    expect(TOKEN_ORIGIN_GUIDANCE.rulesForAgents.join(" ")).toMatch(
      /pHEX.*preferred|preferred.*pHEX/i,
    );
    expect(TOKEN_ORIGIN_GUIDANCE.rulesForAgents.join(" ")).toMatch(
      /discovery-only|Address identity always beats/i,
    );
    expect(TOKEN_ORIGIN_GUIDANCE.rulesForAgents.length).toBeGreaterThan(5);
    expect(TOKEN_ORIGIN_GUIDANCE.residualLimits.length).toBeGreaterThan(0);
  });
});

describe("RO_RESEARCH_GUIDANCE (v0.1.37)", () => {
  it("encodes e*/p*, pHEX exception, address-first, discovery-only, tool preference", () => {
    const text = JSON.stringify(RO_RESEARCH_GUIDANCE);
    expect(RO_RESEARCH_GUIDANCE.resourceUri).toBe(
      "pulsechain://guidance/ro-research",
    );
    expect(text).toMatch(/e\*.*bridged|bridged.*e\*/i);
    expect(text).toMatch(/pHEX.*preferred|preferred.*pHEX/i);
    expect(text).toMatch(/Address identity always beats ticker/i);
    expect(text).toMatch(/discovery-only/i);
    expect(RO_RESEARCH_GUIDANCE.toolPreference.identity).toMatch(
      /get_token_info|dexscreener_token_pairs/,
    );
    expect(RO_RESEARCH_GUIDANCE.toolPreference.discovery).toMatch(
      /dexscreener_search|recommended_address_followups/,
    );
    expect(RO_RESEARCH_GUIDANCE.toolPreference.price).toMatch(/get_token_price/);
    expect(RO_RESEARCH_GUIDANCE.toolPreference.quote).toMatch(
      /pulseswap_quote|pulsex_quote/,
    );
    expect(RO_RESEARCH_GUIDANCE.principles.some((p) => /pHEX/i.test(p))).toBe(
      true,
    );
  });
});
