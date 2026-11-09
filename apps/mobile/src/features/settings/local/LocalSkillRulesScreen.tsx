import { useRouter } from 'expo-router';
import { useState } from 'react';

import { useOnDeviceSelector } from '../../on-device/runtime/OnDeviceProvider';
import type { LocalSkillEffect, LocalSkillRule } from '../../on-device/runtime/skills';
import type { OnDeviceRuntimeSlice } from '../../on-device/runtime/types';
import { SettingsGroup, SettingsNotice, SettingsRow } from '../SettingsList';
import { ICON_ROW_SEPARATOR_INSET } from '../settingsListStyles';
import { failureMessage, useLocalRuntime } from './hooks';
import {
  SettingsButtonRow,
  SettingsCardText,
  SettingsDetailRow,
  SettingsInlineActions,
  SettingsTextFieldRow,
} from './localSettingsUi';
import { EFFECT_ICON, EFFECT_LABEL, LOCAL_SKILLS_TITLE, SKILL_EFFECTS } from './localSkillsUi';
import { SettingsSubpage } from './SettingsSubpage';

const PREFERENCE_SLICES: readonly OnDeviceRuntimeSlice[] = ['preferences'];
const NONE: readonly string[] = [];
const NO_RULES: readonly LocalSkillRule[] = [];

/**
 * OpenCode `permission.skill` rules owned by the device owner: wildcard patterns over skill IDs,
 * in order, where the last match wins. They apply after project rules, so they win.
 */
export function LocalSkillRulesScreen() {
  const router = useRouter();
  const runtime = useLocalRuntime();
  // rules() builds a new empty list when there are none; keep the snapshot stable.
  const rules = useOnDeviceSelector((current) => {
    const value = current.skills.rules();
    return value.length ? value : NO_RULES;
  }, PREFERENCE_SLICES);
  const turnedOff = useOnDeviceSelector(
    (current) => current.preferences().disabledSkills ?? NONE,
    PREFERENCE_SLICES,
  );
  const [pattern, setPattern] = useState('');
  const [effect, setEffect] = useState<LocalSkillEffect>('deny');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = (next: readonly LocalSkillRule[], added: boolean) => {
    setSaving(true);
    setNotice(null);
    setFieldError(null);
    runtime.skills
      .setRules(next)
      .then(() => {
        if (added) {
          setPattern('');
        }
      })
      .catch((error: unknown) => {
        const text = failureMessage(error, 'The rules could not be saved.');
        if (added) {
          setFieldError(text);
        } else {
          setNotice(text);
        }
      })
      .finally(() => setSaving(false));
  };

  return (
    <SettingsSubpage
      title="Permission rules"
      onBack={() => router.back()}
      backTitle={LOCAL_SKILLS_TITLE}
      testID="settings-local-skills-rules-screen"
    >
      {notice ? <SettingsNotice text={notice} /> : null}
      <SettingsGroup
        title="Your rules"
        footer="Checked in this order; the last rule that matches a skill ID wins. Your rules apply after the workspace’s opencode.json rules, so yours win. Allow and Ask choices on the Skills page appear here."
        separatorInset={ICON_ROW_SEPARATOR_INSET}
      >
        {rules.length === 0 ? (
          <SettingsCardText>
            No rules. Skills are allowed unless a project rule says otherwise.
          </SettingsCardText>
        ) : null}
        {rules.map((rule, index) => (
          <SettingsDetailRow
            key={`${String(index)}:${rule.pattern}`}
            icon={EFFECT_ICON[rule.effect]}
            title={rule.pattern}
            subtitle={`${EFFECT_LABEL[rule.effect]} · rule ${String(index + 1)} of ${String(rules.length)}`}
            testID="settings-local-skill-rule"
          >
            <SettingsInlineActions
              actions={[
                {
                  key: 'delete',
                  label: 'Delete',
                  accessibilityLabel: `Delete rule ${String(index + 1)}, ${rule.pattern}`,
                  icon: 'trash-outline',
                  tone: 'destructive',
                  disabled: saving,
                  onPress: () =>
                    save(
                      rules.filter((_, position) => position !== index),
                      false,
                    ),
                },
              ]}
            />
          </SettingsDetailRow>
        ))}
      </SettingsGroup>
      <SettingsGroup
        title="Add rule"
        footer="Patterns match whole skill IDs: * matches any characters and ? one character, such as internal-*. New rules go last."
      >
        <SettingsTextFieldRow
          label="Pattern"
          value={pattern}
          onChangeText={(value) => {
            setPattern(value);
            setFieldError(null);
          }}
          placeholder="internal-*"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          error={fieldError}
          testID="settings-local-skill-rule-pattern"
        />
        {SKILL_EFFECTS.map((option) => (
          <SettingsRow
            key={option}
            label={EFFECT_LABEL[option]}
            accessory="check"
            selected={effect === option}
            onPress={() => setEffect(option)}
          />
        ))}
        <SettingsButtonRow
          label="Add rule"
          disabled={!pattern.trim()}
          busy={saving}
          testID="settings-local-skill-rule-add"
          onPress={() => save([...rules, { pattern: pattern.trim(), effect }], true)}
        />
      </SettingsGroup>
      {turnedOff.length > 0 ? (
        <SettingsGroup
          title="Denied skills"
          footer="Skills you set to Deny, here or with /skills. A denial always wins over rules."
          separatorInset={ICON_ROW_SEPARATOR_INSET}
        >
          {turnedOff.map((id) => (
            <SettingsDetailRow key={id} icon={EFFECT_ICON.deny} title={id}>
              <SettingsInlineActions
                actions={[
                  {
                    key: 'allow',
                    label: 'Remove denial',
                    accessibilityLabel: `Remove denial for ${id}`,
                    icon: 'arrow-undo-outline',
                    disabled: saving,
                    onPress: () => {
                      setSaving(true);
                      setNotice(null);
                      runtime.skills
                        .setEnabled(id, true)
                        .catch((error: unknown) =>
                          setNotice(failureMessage(error, `${id} could not be turned on.`)),
                        )
                        .finally(() => setSaving(false));
                    },
                  },
                ]}
              />
            </SettingsDetailRow>
          ))}
        </SettingsGroup>
      ) : null}
    </SettingsSubpage>
  );
}
