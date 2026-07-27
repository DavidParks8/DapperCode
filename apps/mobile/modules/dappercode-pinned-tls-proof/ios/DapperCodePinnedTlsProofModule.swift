import ExpoModulesCore
import Foundation
import UIKit

public final class DapperCodePinnedTlsProofModule: Module {
  private let identityStore = PinnedTlsIdentityStore()
  private let reportLock = NSLock()
  private var pendingReport: [String: Any]?
  private var pendingHardwareGateCandidate = false

  public func definition() -> ModuleDefinition {
    Name("DapperCodePinnedTlsProof")

    Constant("isRequested") {
      ProcessInfo.processInfo.arguments.contains("--dappercode-pinned-tls-proof")
        || ProcessInfo.processInfo.environment["DAPPERCODE_PINNED_TLS_PROOF"] == "1"
    }

    Function("launchConfiguration") {
      let environment = ProcessInfo.processInfo.environment
      return [
        "httpsURL": environment["DAPPERCODE_PINNED_TLS_HTTPS_URL"] ?? "",
        "wssURL": environment["DAPPERCODE_PINNED_TLS_WSS_URL"] ?? "",
        "hostname": environment["DAPPERCODE_PINNED_TLS_HOSTNAME"] ?? "",
        "serverSPKIPin": environment["DAPPERCODE_PINNED_TLS_SERVER_SPKI"] ?? "",
        "substitutionHTTPSURL":
          environment["DAPPERCODE_PINNED_TLS_SUBSTITUTION_HTTPS_URL"] ?? "",
        "substitutionServerSPKIPin":
          environment["DAPPERCODE_PINNED_TLS_SUBSTITUTION_SERVER_SPKI"] ?? "",
        "automaticPromptCount": environment["DAPPERCODE_PINNED_TLS_PROMPT_COUNT"] ?? "",
        "automaticPromptCountSource":
          environment["DAPPERCODE_PINNED_TLS_PROMPT_COUNT_SOURCE"] ?? "",
        "requireNetworkTransition":
          environment["DAPPERCODE_PINNED_TLS_REQUIRE_NETWORK_TRANSITION"] ?? "",
        "runID": environment["DAPPERCODE_PINNED_TLS_RUN_ID"] ?? "",
      ]
    }

    AsyncFunction("prepareIdentity") { () -> [String: Any] in
      let identity = try self.identityStore.prepare()
      var report = identity.publicReport()
      report["runID"] = Self.runID()
      try Self.writeReport(report, named: "pinned-tls-prepared.json")
      return report
    }

    AsyncFunction("runProof") {
      (
        httpsURLString: String,
        wssURLString: String,
        hostname: String,
        serverSPKIPin: String,
        substitutionHTTPSURLString: String,
        substitutionServerSPKIPin: String,
        requireNetworkTransition: Bool
      ) -> [String: Any] in
      guard let httpsURL = URL(string: httpsURLString),
        let wssURL = URL(string: wssURLString),
        let substitutionHTTPSURL = URL(string: substitutionHTTPSURLString),
        !hostname.isEmpty,
        !serverSPKIPin.isEmpty,
        !substitutionServerSPKIPin.isEmpty
      else {
        throw PinnedTlsProofError.invalidInput("proof launch configuration is incomplete")
      }

      let original = try self.identityStore.prepare()
      let initial = try await PinnedTlsTransport.run(
        httpsURL: httpsURL,
        wssURL: wssURL,
        hostname: hostname,
        serverSPKIPin: serverSPKIPin,
        identity: original
      )
      let wrongPin =
        serverSPKIPin == String(repeating: "A", count: 43)
        ? String(repeating: "B", count: 43) : String(repeating: "A", count: 43)
      let wrongServerPinRejected = await PinnedTlsTransport.expectServerTrustRejection(
        httpsURL: httpsURL,
        hostname: hostname,
        serverSPKIPin: wrongPin,
        identity: original
      )
      guard wrongServerPinRejected else {
        throw PinnedTlsProofError.trust("native transport accepted a server with the wrong SPKI pin")
      }
      let wrongHostnameRejected = await PinnedTlsTransport.expectServerTrustRejection(
        httpsURL: httpsURL,
        hostname: "wrong-host.invalid",
        serverSPKIPin: serverSPKIPin,
        identity: original
      )
      guard wrongHostnameRejected else {
        throw PinnedTlsProofError.trust("native transport accepted the wrong server hostname")
      }
      let caSignedServerSubstitutionRejected =
        await PinnedTlsTransport.expectServerTrustRejection(
          httpsURL: substitutionHTTPSURL,
          hostname: hostname,
          serverSPKIPin: substitutionServerSPKIPin,
          identity: original
        )
      guard caSignedServerSubstitutionRejected else {
        throw PinnedTlsProofError.trust(
          "native transport accepted a CA-signed server substitution"
        )
      }
      let renewed = try self.identityStore.prepare(forceRenewWrapper: true)
      guard original.spkiPin == renewed.spkiPin else {
        throw PinnedTlsProofError.certificate("wrapper renewal changed the client SPKI")
      }
      if requireNetworkTransition {
        try await PinnedTlsNetworkTransition.wait(timeout: 120)
      }
      let reconnect = try await PinnedTlsTransport.run(
        httpsURL: httpsURL,
        wssURL: wssURL,
        hostname: hostname,
        serverSPKIPin: serverSPKIPin,
        identity: renewed
      )

      let initialHTTPSIdentity = initial.challenges["httpsIdentityPresented"] as? Bool == true
      let initialWSSIdentity = initial.challenges["wssIdentityPresented"] as? Bool == true
      let initialHTTPSEmptyHints = initial.challenges["httpsEmptyCAHint"] as? Bool == true
      let initialWSSEmptyHints = initial.challenges["wssEmptyCAHint"] as? Bool == true
      let reconnectPassed = reconnect.httpsPassed && reconnect.wssPassed
      let hardwareGateCandidate =
        renewed.hardwareBacked && renewed.privateKeyExportFailed && renewed.storageClassVerified
        && renewed.accessControlVerified && initial.httpsPassed
        && initial.wssPassed && initialHTTPSIdentity && initialWSSIdentity
        && initialHTTPSEmptyHints && initialWSSEmptyHints
        && wrongServerPinRejected && wrongHostnameRejected
        && caSignedServerSubstitutionRejected && reconnectPassed

      var report = renewed.publicReport(wrapperRenewed: true)
      report.merge(
        [
          "deviceOSVersion": UIDevice.current.systemVersion,
          "deploymentTarget": "15.1",
          "httpsPassed": initial.httpsPassed,
          "wssPassed": initial.wssPassed,
          "httpsIdentityPresentedWithEmptyCAHints": initialHTTPSIdentity && initialHTTPSEmptyHints,
          "wssIdentityPresentedWithEmptyCAHints": initialWSSIdentity && initialWSSEmptyHints,
          "wrongServerPinRejected": wrongServerPinRejected,
          "wrongHostnameRejected": wrongHostnameRejected,
          "caSignedServerSubstitutionRejected": caSignedServerSubstitutionRejected,
          "wrapperRenewalSPKIStable": original.spkiPin == renewed.spkiPin,
          "reconnectPassed": reconnectPassed,
          "networkTransitionRequired": requireNetworkTransition,
          "promptCount": NSNull(),
          "promptCountSource": "pendingOperatorObservation",
          "tlsVersion": "TLS1.3",
          "hardwareGatePassed": false,
          "runID": Self.runID(),
        ],
        uniquingKeysWith: { _, new in new }
      )
      self.reportLock.lock()
      self.pendingReport = report
      self.pendingHardwareGateCandidate = hardwareGateCandidate
      self.reportLock.unlock()
      return report
    }

    AsyncFunction("finalizeProof") {
      (observedPromptCount: Int, promptCountSource: String) -> [String: Any] in
      let operatorObserved = promptCountSource == "operatorObserved" && observedPromptCount >= 0
      let simulatorNotObserved =
        promptCountSource == "simulatorNotObserved" && observedPromptCount == -1
      guard operatorObserved || simulatorNotObserved else {
        throw PinnedTlsProofError.invalidInput("prompt evidence is invalid for its source")
      }
      self.reportLock.lock()
      guard var report = self.pendingReport else {
        self.reportLock.unlock()
        throw PinnedTlsProofError.invalidInput("no proof run is awaiting prompt confirmation")
      }
      let hardwareGateCandidate = self.pendingHardwareGateCandidate
      self.pendingReport = nil
      self.pendingHardwareGateCandidate = false
      self.reportLock.unlock()

      report["promptCount"] = operatorObserved ? observedPromptCount : NSNull()
      report["promptCountSource"] = promptCountSource
      report["hardwareGatePassed"] =
        hardwareGateCandidate && operatorObserved && observedPromptCount == 0
      try Self.writeReport(report, named: "pinned-tls-report.json")
      return report
    }
  }

  private static func writeReport(_ report: [String: Any], named filename: String) throws {
    guard JSONSerialization.isValidJSONObject(report) else {
      throw PinnedTlsProofError.invalidInput("proof report is not valid JSON")
    }
    let data = try JSONSerialization.data(
      withJSONObject: report,
      options: [.prettyPrinted, .sortedKeys]
    )
    let documents = try FileManager.default.url(
      for: .documentDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    )
    try data.write(to: documents.appendingPathComponent(filename), options: .atomic)
  }

  private static func runID() -> String {
    ProcessInfo.processInfo.environment["DAPPERCODE_PINNED_TLS_RUN_ID"] ?? ""
  }
}
