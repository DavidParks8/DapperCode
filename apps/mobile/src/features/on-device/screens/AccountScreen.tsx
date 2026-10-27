import * as Clipboard from 'expo-clipboard';
import { useEffect, useState } from 'react';
import { Linking } from 'react-native';

import type { GitDeviceAuthorization } from '../auth/strategy';
import { useOnDeviceRuntime } from '../runtime/OnDeviceProvider';
import { LocalAction, LocalCard, LocalField, LocalPage, LocalText, useLocalOperation } from './ui';

export function LocalAccountScreen() {
  const runtime = useOnDeviceRuntime();
  const preferences = runtime.preferences();
  const [name, setName] = useState(preferences.author?.name ?? '');
  const [email, setEmail] = useState(preferences.author?.email ?? '');
  const [code, setCode] = useState<GitDeviceAuthorization | null>(null);
  const operation = useLocalOperation();
  const browser = useLocalOperation();
  useEffect(() => () => runtime.authentication.cancelSignIn(), [runtime]);
  return (
    <LocalPage
      title="GitHub and author"
      busy={operation.busy}
      error={operation.error ?? browser.error}
    >
      <LocalCard>
        <LocalText title>GitHub</LocalText>
        <LocalText>
          Sign-in is used only for private HTTPS clones and push. Tokens are device-only Keychain
          entries; the model never receives them.
        </LocalText>
        {!runtime.authConfigured() ? (
          <LocalText>
            GitHub sign-in is not configured in this build. Set the public
            EXPO_PUBLIC_GITHUB_CLIENT_ID for an OAuth app with Device Flow enabled, then rebuild. No
            client secret is required.
          </LocalText>
        ) : null}
        {preferences.account ? (
          <>
            <LocalText>Signed in as {preferences.account.login}</LocalText>
            <LocalAction
              title="Sign out of GitHub"
              disabled={operation.busy}
              onPress={() => operation.run(() => runtime.signOut())}
            />
          </>
        ) : (
          <LocalAction
            title="Sign in to GitHub"
            disabled={operation.busy || !runtime.authConfigured()}
            onPress={() =>
              operation.run(async () => {
                try {
                  await runtime.signIn(async (authorization) => {
                    setCode(authorization);
                    await Linking.openURL(authorization.verificationUrl);
                  });
                  setName(runtime.preferences().author?.name ?? '');
                  setEmail(runtime.preferences().author?.email ?? '');
                } finally {
                  setCode(null);
                }
              })
            }
          />
        )}
        {code ? (
          <>
            <LocalText title>{code.userCode}</LocalText>
            <LocalText>
              Enter this code at {code.verificationUrl}. Waiting for GitHub authorization…
            </LocalText>
            <LocalAction
              title="Copy authorization code"
              onPress={() => browser.run(() => Clipboard.setStringAsync(code.userCode))}
            />
            <LocalAction
              title="Open GitHub authorization"
              onPress={() => browser.run(() => Linking.openURL(code.verificationUrl))}
            />
            <LocalAction
              title="Cancel sign-in"
              onPress={() => runtime.authentication.cancelSignIn()}
            />
          </>
        ) : null}
      </LocalCard>
      <LocalCard>
        <LocalText title>Offline commit author</LocalText>
        <LocalText>
          This identity is written into commits. It does not authenticate network operations.
        </LocalText>
        <LocalField label="Git author name" value={name} onChangeText={setName} maxLength={200} />
        <LocalField
          label="Git author email"
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          maxLength={200}
        />
        <LocalAction
          title="Save author identity"
          disabled={operation.busy || !name.trim() || !email.trim()}
          onPress={() => operation.run(() => runtime.saveAuthor({ name, email }))}
        />
      </LocalCard>
    </LocalPage>
  );
}
