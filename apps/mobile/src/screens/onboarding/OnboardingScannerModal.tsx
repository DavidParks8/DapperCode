import { Ionicons } from '@expo/vector-icons';
import { CameraView } from 'expo-camera';
import { Modal, Pressable, Text, View } from 'react-native';

import { decorativeAccessibilityProps } from '../../accessibility';
import type { AppTheme } from '../../theme';
import type { createOnboardingStyles } from './onboardingScreenStyles';

interface ScannerModalProps {
  styles: ReturnType<typeof createOnboardingStyles>;
  theme: AppTheme;
  scannerVisible: boolean;
  cameraPermissionGranted: boolean;
  scannerLocked: boolean;
  scannerError: string | null;
  scannerFocusRef: React.RefObject<Text | null>;
  onClose: () => void;
  onBarcodeScanned: (data: string) => void;
}

export function OnboardingScannerModal({
  styles,
  theme,
  scannerVisible,
  cameraPermissionGranted,
  scannerLocked,
  scannerError,
  scannerFocusRef,
  onClose,
  onBarcodeScanned,
}: ScannerModalProps) {
  return (
    <Modal animationType="slide" visible={scannerVisible} transparent onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close QR scanner"
        onPress={onClose}
        style={styles.scannerModalRoot}
        accessibilityViewIsModal
      >
        <Pressable
          accessibilityRole="none"
          onPress={(event) => {
            event.stopPropagation();
          }}
          style={styles.scannerSheet}
        >
          <View style={styles.scannerHeader}>
            <Text ref={scannerFocusRef} accessibilityRole="header" style={styles.scannerTitle}>
              Scan Pairing QR
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close QR scanner"
              onPress={onClose}
              hitSlop={8}
              style={({ pressed }) => [styles.scannerCloseBtn, pressed && styles.scannerCloseBtnPressed]}
            >
              <Ionicons
                {...decorativeAccessibilityProps}
                name="close"
                size={18}
                color={theme.colors.textPrimary}
              />
            </Pressable>
          </View>
          <View style={styles.scannerCameraFrame}>
            {cameraPermissionGranted ? (
              <CameraView
                style={styles.scannerCamera}
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={
                  scannerLocked
                    ? undefined
                    : (result) => {
                        onBarcodeScanned(result.data);
                      }
                }
              />
            ) : (
              <View style={styles.scannerPermissionWrap}>
                <Text style={styles.scannerPermissionText}>
                  Camera permission is required to scan the pairing QR.
                </Text>
              </View>
            )}
          </View>
          <Text style={styles.scannerHintText}>Scan the pairing QR to fill the URL and token.</Text>
          {scannerError ? (
            <Text
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
              style={styles.errorText}
            >
              {scannerError}
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel QR scan"
            onPress={onClose}
            style={({ pressed }) => [
              styles.scannerCancelButton,
              pressed && styles.scannerCancelButtonPressed,
            ]}
          >
            <Text style={styles.scannerCancelButtonText}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
