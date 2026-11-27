import { Ionicons } from '@expo/vector-icons';
import { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { BridgeUiAction, BridgeUiSurface } from '@bridge/types/types';
import {
  controlAccessibilityState,
  decorativeAccessibilityProps,
  useAccessibilityAnnouncement,
  useModalAccessibilityFocus,
} from '@shared/accessibility';
import { feedback } from '@shared/feedback';
import { useAppTheme, type AppTheme } from '@shared/theme';
import { AppSheet } from '@shared/ui/AppSheet';
import { computeHitSlop } from '@shared/ui/touchTarget';
import type { BridgeUiActionHandler } from '../approvals/SurfaceRenderers';
import { parsePhoneCallApproval } from './phoneCallApproval';
import { createPhoneCallApprovalStyles } from './phoneCallApprovalStyles';

type ApprovalStyles = ReturnType<typeof createPhoneCallApprovalStyles>;

interface PhoneCallApprovalSheetProps {
  surface: BridgeUiSurface;
  onAction: BridgeUiActionHandler;
  onDismiss: (surface: BridgeUiSurface) => void;
}

/**
 * Dedicated pre-dial confirmation sheet: formatted recipient header, scannable call plan with
 * inline editing for objective/opening/background notes, quiet caller-ID footer, and guarded
 * Approve & Call / Cancel actions.
 */
export function PhoneCallApprovalSheet({
  surface,
  onAction,
  onDismiss,
}: PhoneCallApprovalSheetProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createPhoneCallApprovalStyles(theme), [theme]);
  const model = useMemo(() => parsePhoneCallApproval(surface), [surface]);
  const modalFocusRef = useModalAccessibilityFocus(true);

  const [editing, setEditing] = useState(false);
  const [objective, setObjective] = useState(model.objective);
  const [firstMessage, setFirstMessage] = useState(model.firstMessage);
  const [context, setContext] = useState(model.context);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [actionError, setActionError] = useState(false);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);

  useAccessibilityAnnouncement(`Approve phone call to ${model.callee.displayName}`);

  useEffect(() => {
    setObjective(model.objective);
    setFirstMessage(model.firstMessage);
    setContext(model.context);
    setEditing(false);
    setValidationError(null);
    setActionError(false);
  }, [surface.id, model.objective, model.firstMessage, model.context]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isModified =
    objective.trim() !== model.objective.trim() ||
    firstMessage.trim() !== model.firstMessage.trim() ||
    context.trim() !== model.context.trim();

  const dispatchAction = (action: BridgeUiAction, payload?: Record<string, unknown>) => {
    if (inFlightRef.current) {
      return;
    }
    setActionError(false);
    setValidationError(null);
    void feedback.selection();
    let outcome: ReturnType<BridgeUiActionHandler>;
    try {
      outcome =
        payload !== undefined ? onAction(surface, action, payload) : onAction(surface, action);
    } catch {
      setActionError(true);
      return;
    }
    if (outcome instanceof Promise) {
      inFlightRef.current = true;
      setPendingActionId(action.id);
      void outcome
        .then((ok) => {
          if (mountedRef.current && !ok) {
            setActionError(true);
          }
        })
        .catch(() => {
          if (mountedRef.current) {
            setActionError(true);
          }
        })
        .finally(() => {
          inFlightRef.current = false;
          if (mountedRef.current) {
            setPendingActionId(null);
          }
        });
    }
  };

  const handleApprove = () => {
    if (!model.approveAction) {
      return;
    }
    const trimmedObjective = objective.trim();
    if (!trimmedObjective) {
      setValidationError('Enter an objective before placing the call.');
      return;
    }
    const payload = isModified
      ? {
          objective: trimmedObjective,
          firstMessage: firstMessage.trim(),
          context: context.trim(),
        }
      : undefined;
    dispatchAction(model.approveAction, payload);
  };

  const handleCancel = () => {
    if (!model.cancelAction) {
      return;
    }
    dispatchAction(model.cancelAction);
  };

  const handleReset = () => {
    void feedback.selection();
    setObjective(model.objective);
    setFirstMessage(model.firstMessage);
    setContext(model.context);
    setValidationError(null);
  };

  const dismissible = surface.dismissible !== false;
  const footerParts = [
    model.callerIdFormatted ? `Calling from ${model.callerIdFormatted}` : null,
    model.onBehalfOf ? `On behalf of ${model.onBehalfOf}` : null,
  ].filter(Boolean);

  return (
    <AppSheet
      visible
      dismissible={dismissible}
      accessibilityLabel={`Approve outbound phone call to ${model.callee.displayName}`}
      onClose={() => {
        if (dismissible) {
          onDismiss(surface);
        }
      }}
    >
      <View ref={modalFocusRef} style={styles.header} testID="phone-call-approval-sheet">
        <View style={styles.iconWrap}>
          <Ionicons
            {...decorativeAccessibilityProps}
            name="call-outline"
            size={20}
            color={theme.colors.warning}
          />
        </View>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>Approve outbound call</Text>
          <Text style={styles.calleeTitle}>{model.callee.displayName}</Text>
          {model.callee.name && model.callee.formattedNumber ? (
            <Text style={styles.calleeNumber}>{model.callee.formattedNumber}</Text>
          ) : null}
        </View>
      </View>

      <ScrollView
        style={styles.bodyScroll}
        contentContainerStyle={styles.bodyContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <ApprovalPlanCard
          editing={editing}
          isModified={isModified}
          disabled={pendingActionId !== null}
          objective={objective}
          firstMessage={firstMessage}
          context={context}
          onChangeObjective={(value) => {
            setObjective(value);
            if (validationError) {
              setValidationError(null);
            }
          }}
          onChangeFirstMessage={setFirstMessage}
          onChangeContext={setContext}
          onToggleEdit={() => {
            void feedback.selection();
            setEditing((current) => !current);
            setValidationError(null);
          }}
          onReset={handleReset}
          styles={styles}
          theme={theme}
        />

        {footerParts.length > 0 ? (
          <Text style={styles.footerMeta} testID="phone-call-approval-footer">
            {footerParts.join(' · ')}
          </Text>
        ) : null}
      </ScrollView>

      {validationError ? (
        <Text
          style={styles.errorText}
          accessibilityRole="alert"
          testID="phone-call-approval-validation-error"
        >
          {validationError}
        </Text>
      ) : null}
      {actionError ? (
        <Text
          style={styles.errorText}
          accessibilityRole="alert"
          testID="phone-call-approval-action-error"
        >
          {"That didn't go through. Check the connection and try again."}
        </Text>
      ) : null}

      <ApprovalActionsRow
        approveAction={model.approveAction}
        cancelAction={model.cancelAction}
        isModified={isModified}
        pendingActionId={pendingActionId}
        onApprove={handleApprove}
        onCancel={handleCancel}
        styles={styles}
        theme={theme}
      />
    </AppSheet>
  );
}

function ApprovalPlanCard({
  editing,
  isModified,
  disabled,
  objective,
  firstMessage,
  context,
  onChangeObjective,
  onChangeFirstMessage,
  onChangeContext,
  onToggleEdit,
  onReset,
  styles,
  theme,
}: {
  editing: boolean;
  isModified: boolean;
  disabled: boolean;
  objective: string;
  firstMessage: string;
  context: string;
  onChangeObjective: (value: string) => void;
  onChangeFirstMessage: (value: string) => void;
  onChangeContext: (value: string) => void;
  onToggleEdit: () => void;
  onReset: () => void;
  styles: ApprovalStyles;
  theme: AppTheme;
}) {
  const FieldInput = Platform.OS === 'web' ? TextInput : BottomSheetTextInput;
  const inlineButtonHitSlop = useMemo(
    () => computeHitSlop({ width: 56, height: 32 }, { maxHorizontal: 4 }),
    [],
  );
  return (
    <View style={styles.planCard}>
      <View style={styles.planHeader}>
        <Text style={styles.planHeading}>Plan for this call</Text>
        <View style={styles.planHeaderActions}>
          {isModified ? (
            <Pressable
              onPress={onReset}
              disabled={disabled}
              hitSlop={inlineButtonHitSlop}
              style={({ pressed }) => [styles.inlineButton, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel="Reset call plan edits"
              testID="phone-call-approval-reset"
            >
              <Text style={styles.inlineButtonMuted}>Reset</Text>
            </Pressable>
          ) : null}
          <Pressable
            onPress={onToggleEdit}
            disabled={disabled}
            hitSlop={inlineButtonHitSlop}
            style={({ pressed }) => [styles.inlineButton, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={editing ? 'Done editing call plan' : 'Edit call plan'}
            testID="phone-call-approval-edit-toggle"
          >
            <Text style={styles.inlineButtonLabel}>{editing ? 'Done' : 'Edit'}</Text>
          </Pressable>
        </View>
      </View>

      {editing ? (
        <View style={styles.editFields}>
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Goal</Text>
            <FieldInput
              value={objective}
              onChangeText={onChangeObjective}
              multiline
              editable={!disabled}
              placeholder="What should the agent accomplish on this call?"
              placeholderTextColor={theme.colors.textMuted}
              keyboardAppearance={theme.keyboardAppearance}
              style={styles.textInput}
              accessibilityLabel="Call goal"
              testID="phone-call-approval-objective-input"
            />
          </View>
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Opening line (optional)</Text>
            <FieldInput
              value={firstMessage}
              onChangeText={onChangeFirstMessage}
              multiline
              editable={!disabled}
              placeholder="Optional first sentence the agent says"
              placeholderTextColor={theme.colors.textMuted}
              keyboardAppearance={theme.keyboardAppearance}
              style={styles.textInput}
              accessibilityLabel="Opening line"
              testID="phone-call-approval-first-message-input"
            />
          </View>
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Background facts (optional)</Text>
            <FieldInput
              value={context}
              onChangeText={onChangeContext}
              multiline
              editable={!disabled}
              placeholder="Key details the agent is allowed to share"
              placeholderTextColor={theme.colors.textMuted}
              keyboardAppearance={theme.keyboardAppearance}
              style={styles.textInput}
              accessibilityLabel="Background facts"
              testID="phone-call-approval-context-input"
            />
          </View>
        </View>
      ) : (
        <View style={styles.readFields}>
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Goal</Text>
            <Text style={styles.fieldValue}>{objective.trim() || 'Phone call'}</Text>
          </View>
          {firstMessage.trim() ? (
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>Opening line</Text>
              <Text style={styles.fieldValue}>{firstMessage.trim()}</Text>
            </View>
          ) : null}
          {context.trim() ? (
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>Background facts</Text>
              <Text style={styles.fieldValue}>{context.trim()}</Text>
            </View>
          ) : null}
        </View>
      )}
    </View>
  );
}

function ApprovalActionsRow({
  approveAction,
  cancelAction,
  isModified,
  pendingActionId,
  onApprove,
  onCancel,
  styles,
  theme,
}: {
  approveAction: BridgeUiAction | null;
  cancelAction: BridgeUiAction | null;
  isModified: boolean;
  pendingActionId: string | null;
  onApprove: () => void;
  onCancel: () => void;
  styles: ApprovalStyles;
  theme: AppTheme;
}) {
  return (
    <View style={styles.actionsRow}>
      {cancelAction ? (
        <Pressable
          onPress={onCancel}
          disabled={pendingActionId !== null}
          style={({ pressed }) => [
            styles.button,
            styles.cancelButton,
            (pressed || pendingActionId !== null) && styles.pressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel={cancelAction.label}
          accessibilityState={controlAccessibilityState({
            disabled: pendingActionId !== null,
            busy: pendingActionId === cancelAction.id,
          })}
          testID="phone-call-approval-cancel"
        >
          {pendingActionId === cancelAction.id ? (
            <ActivityIndicator size="small" color={theme.colors.error} />
          ) : (
            <Text style={styles.cancelLabel}>{cancelAction.label}</Text>
          )}
        </Pressable>
      ) : null}
      {approveAction ? (
        <Pressable
          onPress={onApprove}
          disabled={pendingActionId !== null}
          style={({ pressed }) => [
            styles.button,
            styles.approveButton,
            (pressed || pendingActionId !== null) && styles.pressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel={approveAction.label}
          accessibilityState={controlAccessibilityState({
            disabled: pendingActionId !== null,
            busy: pendingActionId === approveAction.id,
          })}
          testID="phone-call-approval-approve"
        >
          {pendingActionId === approveAction.id ? (
            <ActivityIndicator size="small" color={theme.colors.accentText} />
          ) : (
            <Text style={styles.approveLabel}>
              {isModified ? 'Save & Call' : approveAction.label}
            </Text>
          )}
        </Pressable>
      ) : null}
    </View>
  );
}
