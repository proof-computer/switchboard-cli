import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  launchDemoManagerScopeProcessors,
  launchDemoReportEligibilityReason,
  selectLaunchDemoCandidatePool,
  selectLaunchDemoMembers
} from "../cli/src/index.js";

describe("launch-demo HA member selection", () => {
  it("prefers one member per gateway, then fills by lowest active route count", () => {
    const selected = selectLaunchDemoMembers(
      [
        launchDemoCandidate({ gatewayId: "gateway-a", processorId: hex32("01"), activeRouteCount: 1 }),
        launchDemoCandidate({ gatewayId: "gateway-a", processorId: hex32("02"), activeRouteCount: 4 }),
        launchDemoCandidate({ gatewayId: "gateway-b", processorId: hex32("03"), activeRouteCount: 2 }),
        launchDemoCandidate({ gatewayId: "gateway-c", processorId: hex32("04"), activeRouteCount: 3 }),
        launchDemoCandidate({ gatewayId: "gateway-b", processorId: hex32("05"), activeRouteCount: 5 })
      ] as any,
      4
    );

    assert.deepEqual(
      selected.map((member) => `${member.gatewayId}:${member.processorId}`),
      [`gateway-a:${hex32("01")}`, `gateway-b:${hex32("03")}`, `gateway-c:${hex32("04")}`, `gateway-a:${hex32("02")}`]
    );
    assert.deepEqual(selected.map((member) => member.memberId), ["member-1", "member-2", "member-3", "member-4"]);
  });

  it("rejects HA selection when capacity comes from only one gateway", () => {
    assert.throws(
      () =>
        selectLaunchDemoMembers(
          [
            launchDemoCandidate({ gatewayId: "gateway-a", processorId: hex32("01"), activeRouteCount: 1 }),
            launchDemoCandidate({ gatewayId: "gateway-a", processorId: hex32("02"), activeRouteCount: 2 })
          ] as any,
          2
        ),
      /requires at least two eligible gateways/
    );
  });

  it("selects one processor for single-replica demos", () => {
    const selected = selectLaunchDemoCandidatePool(
      [
        launchDemoCandidate({ gatewayId: "gateway-a", processorId: hex32("01"), activeRouteCount: 1 }),
        launchDemoCandidate({ gatewayId: "gateway-a", processorId: hex32("02"), activeRouteCount: 1 }),
        launchDemoCandidate({ gatewayId: "gateway-a", processorId: hex32("03"), activeRouteCount: 1 })
      ] as any,
      1
    );

    assert.deepEqual(
      selected.map((member) => member.processorId),
      [hex32("01")]
    );
    assert.deepEqual(selected.map((member) => member.memberId), ["member-1"]);
  });

  it("requires launch-demo gateways to advertise route-state polling", () => {
    assert.equal(
      launchDemoReportEligibilityReason({
        version: 1,
        kind: "switchboard.operator.capability",
        reportId: "route-less-report",
        reportedAt: new Date().toISOString(),
        expiresAt: "2099-01-01T00:00:00.000Z",
        operator: {
          operatorId: hex32("aa"),
          gatewayId: "gateway-route-less"
        },
        gateway: {
          publicAddresses: ["2.122.7.112"],
          activeRouteCount: 0,
          routeCapacity: 20,
          supportedClasses: ["node-webserver"]
        },
        processorScopes: []
      } as any),
      "route-state polling unavailable"
    );
  });

  it("accepts sanitized public capacity route-state markers", () => {
    assert.equal(
      launchDemoReportEligibilityReason({
        version: 1,
        kind: "switchboard.operator.capability",
        reportId: "sanitized-public-capacity",
        reportedAt: new Date().toISOString(),
        expiresAt: "2099-01-01T00:00:00.000Z",
        operator: {
          operatorId: hex32("aa"),
          gatewayId: "gateway-public-capacity"
        },
        gateway: {
          publicAddresses: ["2.122.7.112"],
          routeStateAvailable: true,
          activeRouteCount: 0,
          routeCapacity: 20,
          supportedClasses: ["node-webserver"]
        },
        processorScopes: []
      } as any),
      undefined
    );
  });

  it("does not treat an empty manager scope as all manager processors", () => {
    assert.deepEqual(
      launchDemoManagerScopeProcessors({
        kind: "manager",
        managerId: "9470"
      }),
      []
    );
    assert.deepEqual(
      launchDemoManagerScopeProcessors({
        kind: "manager",
        managerId: "9470",
        processors: ["5LocalProcessor"],
        includeProcessors: ["5LocalProcessor", "5OtherLocalProcessor"]
      }),
      ["5LocalProcessor", "5OtherLocalProcessor"]
    );
  });
});

function launchDemoCandidate(input: {
  gatewayId: string;
  processorId: string;
  activeRouteCount: number;
}): Record<string, unknown> {
  return {
    memberId: "candidate",
    operatorId: hex32("aa"),
    gatewayId: input.gatewayId,
    managerId: "9470",
    processor: `processor-${input.processorId.slice(-2)}`,
    processorId: input.processorId,
    reportId: `report-${input.gatewayId}`,
    reportExpiresAt: "2099-01-01T00:00:00.000Z",
    publicAddresses: ["203.0.113.10"],
    activeRouteCount: input.activeRouteCount,
    routeCapacity: 20,
    routeStateUrl: `https://control.switchboard.proof.computer/v1/operators/${hex32("aa")}/gateways/${input.gatewayId}/route-state`,
    readiness: {
      processor: `processor-${input.processorId.slice(-2)}`,
      heartbeatAgeSeconds: input.activeRouteCount,
      availability: { available: true }
    }
  };
}

function hex32(byte: string): string {
  return `0x${byte.repeat(32)}`;
}
