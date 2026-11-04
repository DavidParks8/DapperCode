import * as Clipboard from 'expo-clipboard';
import { useAtomValue, useStore } from 'jotai';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, Text, View } from 'react-native';

import { useAccessibilityAnnouncement } from '@shared/accessibility';
import { feedback } from '@shared/feedback';
import { useAppTheme, type AppTheme } from '@shared/theme';
import { useOnDeviceSelector } from '../../on-device/runtime/OnDeviceProvider';
import type { OnDeviceRuntimeSlice } from '../../on-device/runtime/types';
import { SettingsGroup, SettingsNotice, SettingsRow } from '../SettingsList';
import { useLocalRuntime } from './hooks';
import { SettingsButtonRow, SettingsInlineActions, SettingsTextFieldRow } from './localSettingsUi';
import { SettingsSubpage } from './SettingsSubpage';
import {
  cancelLocalSignIn,
  IDLE_SIGN_IN,
  localSignInAtom,
  resetLocalSignIn,
  startLocalSignIn,
} from './signIn';

const PREFERENCE_SLICES: readonly OnDeviceRuntimeSlice[] = ['preferences'];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const LOCAL_GIT_ACCOUNT_TITLE = 'Git & GitHub';

/** Spells a device code out for VoiceOver, so "WDJB-MJHT" is read letter by letter. */
function spokenCode(code: string): string {
  return code
    .split('')
    .map((character) => (character === '-' ? 'dash' : character))
    .join(' ');
}

/** GitHub sign-in for private repositories and push, and the author written into commits. */
export function LocalGitAccountScreen() {
  const router = useRouter();
  return (
    <SettingsSubpage
      title={LOCAL_GIT_ACCOUNT_TITLE}
      onBack={() => router.back()}
      testID="settings-local-account-screen"
    >
      <GitHubSection />
      <AuthorSection />
    </SettingsSubpage>
  );
}

function GitHubSection() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const store = useStore();
  const runtime = useLocalRuntime();
  const account = useOnDeviceSelector(
    (current) => current.preferences().account,
    PREFERENCE_SLICES,
  );
  const stored = useAtomValue(localSignInAtom);
  const signIn = stored.runtime === runtime ? stored : IDLE_SIGN_IN;
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const footer =
    'Needed only for private repositories and push. Your token stays in this iPhone’s Keychain and is never shared with models.';

  useAccessibilityAnnouncement(
    signIn.authorization
      ? `GitHub code ${spokenCode(signIn.authorization.userCode)}${
          signIn.copied ? ', copied to the clipboard' : ''
        }.`
      : null,
  );

  if (account) {
    return (
      <>
        {signOutError ? <SettingsNotice text={signOutError} /> : null}
        <SettingsGroup title="GitHub" footer={footer}>
          <SettingsRow label="Signed in as" value={account.login} />
          <SettingsButtonRow
            label="Sign out"
            tone="destructive"
            busy={signingOut}
            testID="settings-local-github-sign-out"
            onPress={() => {
              setSigningOut(true);
              setSignOutError(null);
              runtime
                .signOut()
                .then(() => resetLocalSignIn(store, runtime))
                .catch((error: unknown) =>
                  setSignOutError(
                    error instanceof Error ? error.message : 'Could not sign out. Try again.',
                  ),
                )
                .finally(() => setSigningOut(false));
            }}
          />
        </SettingsGroup>
      </>
    );
  }

  if (!runtime.authConfigured()) {
    return (
      <SettingsGroup
        title="GitHub"
        footer="GitHub sign-in isn’t available in this version of the app. Public repositories and local commits still work."
      >
        <SettingsRow label="GitHub sign-in" value="Unavailable" />
      </SettingsGroup>
    );
  }

  if (signIn.phase === 'waiting' && signIn.authorization) {
    const { userCode, verificationUrl } = signIn.authorization;
    return (
      <SettingsGroup
        title="GitHub"
        footer="Sign-in continues if you leave this page. Return here any time to see the code."
      >
        <View style={styles.codeCard} testID="settings-local-github-code">
          <Text style={styles.codeHint}>Enter this code on GitHub</Text>
          <Text accessibilityLabel={`Code ${spokenCode(userCode)}`} selectable style={styles.code}>
            {userCode}
          </Text>
          <Text accessibilityLiveRegion="polite" style={styles.codeHint}>
            {copyNote ??
              (signIn.copied ? 'Copied to the clipboard.' : 'Copy the code, then open GitHub.')}
          </Text>
          <SettingsInlineActions
            actions={[
              {
                key: 'open',
                label: 'Open GitHub',
                icon: 'open-outline',
                tone: 'prominent',
                testID: 'settings-local-github-open',
                onPress: () => {
                  void Linking.openURL(verificationUrl).catch(() =>
                    setCopyNote(`Open ${verificationUrl} in a browser.`),
                  );
                },
              },
              {
                key: 'copy',
                label: 'Copy code',
                icon: 'copy-outline',
                onPress: () => {
                  void Clipboard.setStringAsync(userCode)
                    .then(() => {
                      void feedback.success();
                      setCopyNote('Copied to the clipboard.');
                    })
                    .catch(() => setCopyNote('The code could not be copied.'));
                },
              },
              {
                key: 'cancel',
                label: 'Cancel',
                tone: 'destructive',
                testID: 'settings-local-github-cancel',
                onPress: () => cancelLocalSignIn(store, runtime),
              },
            ]}
          />
          <View style={styles.waiting}>
            <ActivityIndicator size="small" color={theme.colors.textMuted} />
            <Text style={styles.codeHint}>Waiting for you to approve on GitHub…</Text>
          </View>
        </View>
      </SettingsGroup>
    );
  }

  return (
    <>
      {signIn.error ? <SettingsNotice text={signIn.error} /> : null}
      <SettingsGroup title="GitHub" footer={footer}>
        <SettingsButtonRow
          label={signIn.phase === 'requesting' ? 'Getting a sign-in code…' : 'Sign in with GitHub'}
          busy={signIn.phase === 'requesting'}
          testID="settings-local-github-sign-in"
          onPress={() => startLocalSignIn(store, runtime)}
        />
      </SettingsGroup>
    </>
  );
}

function validateAuthor(name: string, email: string): { name?: string; email?: string } {
  const errors: { name?: string; email?: string } = {};
  if (!name.trim()) {
    errors.name = 'Enter the name to show on your commits.';
  }
  if (!email.trim()) {
    errors.email = 'Enter the email to show on your commits.';
  } else if (!EMAIL_PATTERN.test(email.trim())) {
    errors.email = 'Enter an email address like name@example.com.';
  }
  return errors;
}

type Author = { name: string; email: string } | null;

/** Author fields that follow the saved author until the user starts editing them. */
function useAuthorFields(author: Author) {
  const savedName = author?.name ?? '';
  const savedEmail = author?.email ?? '';
  const [name, setName] = useState(savedName);
  const [email, setEmail] = useState(savedEmail);
  const baseline = useRef({ name: savedName, email: savedEmail });
  useEffect(() => {
    const previous = baseline.current;
    baseline.current = { name: savedName, email: savedEmail };
    // Adopt a new saved author (for example one set by GitHub sign-in) unless edited.
    setName((current) => (current === previous.name ? savedName : current));
    setEmail((current) => (current === previous.email ? savedEmail : current));
  }, [savedEmail, savedName]);
  const changed = name.trim() !== savedName || email.trim() !== savedEmail;
  return { name, setName, email, setEmail, changed };
}

function AuthorSection() {
  const runtime = useLocalRuntime();
  const author = useOnDeviceSelector((current) => current.preferences().author, PREFERENCE_SLICES);
  const { name, setName, email, setEmail, changed } = useAuthorFields(author);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ kind: 'saved' | 'error'; message: string } | null>(null);
  const errors = validateAuthor(name, email);
  const valid = !errors.name && !errors.email;
  useAccessibilityAnnouncement(result?.kind === 'saved' ? result.message : null);

  const save = () => {
    setTouched(true);
    if (!valid || !changed) {
      return;
    }
    setSaving(true);
    setResult(null);
    runtime
      .saveAuthor({ name, email })
      .then(() => {
        void feedback.success();
        setResult({ kind: 'saved', message: 'Commit author saved.' });
        setTouched(false);
      })
      .catch((error: unknown) =>
        setResult({
          kind: 'error',
          message: error instanceof Error ? error.message : 'The author could not be saved.',
        }),
      )
      .finally(() => setSaving(false));
  };

  const edit = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setResult(null);
  };

  return (
    <SettingsGroup
      title="Commit author"
      footer={
        result?.message ??
        'Written into commits you make on this iPhone. It doesn’t sign you in anywhere.'
      }
    >
      <SettingsTextFieldRow
        label="Name"
        autoCapitalize="words"
        autoComplete="name"
        autoCorrect={false}
        error={touched || name ? errors.name : null}
        maxLength={200}
        onBlur={() => setTouched(true)}
        onChangeText={edit(setName)}
        placeholder="Your Name"
        returnKeyType="next"
        testID="settings-local-author-name"
        textContentType="name"
        value={name}
      />
      <SettingsTextFieldRow
        label="Email"
        autoCapitalize="none"
        autoComplete="email"
        autoCorrect={false}
        error={touched || email ? errors.email : null}
        inputMode="email"
        keyboardType="email-address"
        maxLength={200}
        onBlur={() => setTouched(true)}
        onChangeText={edit(setEmail)}
        onSubmitEditing={save}
        placeholder="you@example.com"
        returnKeyType="done"
        testID="settings-local-author-email"
        textContentType="emailAddress"
        value={email}
      />
      <SettingsButtonRow
        label={result?.kind === 'saved' && !changed ? 'Saved' : 'Save'}
        busy={saving}
        disabled={!changed || !valid}
        testID="settings-local-author-save"
        onPress={save}
      />
    </SettingsGroup>
  );
}

function createStyles(theme: AppTheme) {
  const { colors } = theme;
  return StyleSheet.create({
    codeCard: {
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.lg,
      gap: theme.spacing.sm,
      alignItems: 'center',
      backgroundColor: colors.bgItem,
    },
    code: {
      ...theme.typography.mono,
      color: colors.textPrimary,
      fontSize: 32,
      lineHeight: 40,
      fontWeight: '700',
      letterSpacing: 4,
    },
    codeHint: { ...theme.typography.caption, color: colors.textMuted, textAlign: 'center' },
    waiting: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      marginTop: theme.spacing.xs,
    },
  });
}
