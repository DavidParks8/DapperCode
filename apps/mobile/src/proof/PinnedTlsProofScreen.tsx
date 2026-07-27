import { useCallback, useEffect, useState } from 'react';
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { pinnedTlsProofNativeModule } from './nativePinnedTlsProof';
import type { PinnedTlsIdentityReport, PinnedTlsProofReport } from './nativePinnedTlsProof';

type Phase =
  'preparing' | 'ready' | 'running' | 'confirming' | 'confirmingPrompts' | 'complete' | 'failed';

export function PinnedTlsProofScreen() {
  const [phase, setPhase] = useState<Phase>('preparing');
  const [identity, setIdentity] = useState<PinnedTlsIdentityReport | null>(null);
  const [report, setReport] = useState<PinnedTlsProofReport | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const nativeModule = pinnedTlsProofNativeModule;
    if (!nativeModule) {
      setError('The debug-only pinned TLS native module is unavailable.');
      setPhase('failed');
      return;
    }
    void nativeModule
      .prepareIdentity()
      .then((prepared) => {
        setIdentity(prepared);
        const launch = nativeModule.launchConfiguration();
        setPhase(launch.httpsURL ? 'ready' : 'confirming');
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
        setPhase('failed');
      });
  }, []);

  const run = useCallback(() => {
    const nativeModule = pinnedTlsProofNativeModule;
    if (!nativeModule) return;
    const launch = nativeModule.launchConfiguration();
    setPhase('running');
    void nativeModule
      .runProof(
        launch.httpsURL,
        launch.wssURL,
        launch.hostname,
        launch.serverSPKIPin,
        launch.substitutionHTTPSURL,
        launch.substitutionServerSPKIPin,
        launch.requireNetworkTransition === 'true',
      )
      .then((result) => {
        setReport(result);
        if (launch.automaticPromptCount) {
          return nativeModule.finalizeProof(
            Number.parseInt(launch.automaticPromptCount, 10),
            launch.automaticPromptCountSource === 'simulatorNotObserved'
              ? 'simulatorNotObserved'
              : 'operatorObserved',
          );
        }
        setPhase('confirmingPrompts');
        return null;
      })
      .then((finalReport) => {
        if (finalReport) {
          setReport(finalReport);
          setPhase('complete');
        }
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
        setPhase('failed');
      });
  }, []);

  const finalize = (promptCount: number) => {
    if (!pinnedTlsProofNativeModule) return;
    setPhase('running');
    void pinnedTlsProofNativeModule
      .finalizeProof(promptCount, 'operatorObserved')
      .then((finalReport) => {
        setReport(finalReport);
        setPhase('complete');
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
        setPhase('failed');
      });
  };

  const launch = pinnedTlsProofNativeModule?.launchConfiguration();
  const automaticPromptCount = launch?.automaticPromptCount
    ? Number.parseInt(launch.automaticPromptCount, 10)
    : null;

  useEffect(() => {
    if (
      phase === 'ready' &&
      automaticPromptCount !== null &&
      Number.isFinite(automaticPromptCount)
    ) {
      run();
    }
  }, [automaticPromptCount, phase, run]);

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Pinned TLS platform proof</Text>
        <Text style={styles.status}>Phase: {phase}</Text>
        {identity ? (
          <View style={styles.card}>
            <Text selectable>Client SPKI: {identity.spkiPin}</Text>
            <Text>Hardware backed: {String(identity.hardwareBacked)}</Text>
            <Text>Private-key export failed: {String(identity.privateKeyExportFailed)}</Text>
            <Text>
              Storage: {identity.storageClass} (
              {identity.storageClassVerified ? 'verified' : 'failed'})
            </Text>
            <Text>
              Access control: {identity.accessControl} (
              {identity.accessControlVerified ? 'verified' : 'failed'})
            </Text>
          </View>
        ) : null}
        {phase === 'ready' && automaticPromptCount === null ? (
          <View style={styles.card}>
            <Text>
              Tap Run, wait for the initial HTTPS/WSS checks, induce one real Tailscale network
              transition, then return here. Do not approve any credential prompt.
            </Text>
            <Button title="Run proof" onPress={run} />
          </View>
        ) : null}
        {phase === 'confirmingPrompts' ? (
          <View style={styles.card}>
            <Text>
              How many credential, passcode, or biometric prompts appeared during the run?
            </Text>
            <Button title="Zero prompts" onPress={() => finalize(0)} />
            <Button title="One or more prompts" onPress={() => finalize(1)} color="#b42318" />
          </View>
        ) : null}
        {phase === 'confirming' ? (
          <Text style={styles.card}>
            Identity prepared. The host command will read the public manifest and relaunch this
            screen with the pinned server configuration.
          </Text>
        ) : null}
        {report ? (
          <Text selectable style={styles.report}>
            {JSON.stringify(report, null, 2)}
          </Text>
        ) : null}
        {error ? (
          <Text selectable style={styles.error}>
            {error}
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0c0f12' },
  content: { gap: 16, padding: 20 },
  title: { color: '#fff', fontSize: 24, fontWeight: '700' },
  status: { color: '#9fb3c8', fontSize: 16 },
  card: { backgroundColor: '#eef3f7', borderRadius: 12, gap: 8, padding: 16 },
  report: { backgroundColor: '#102a43', color: '#d9e2ec', padding: 16 },
  error: { backgroundColor: '#7a271a', color: '#fff', padding: 16 },
});
