import { RefObject, useEffect } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

/**
 * Accessibility behavior for modal dialogs:
 * - focuses the first focusable element inside on open
 * - traps Tab / Shift+Tab within the dialog
 * - Escape invokes onClose
 * - restores focus to the previously focused element on close
 */
export const useDialogA11y = (
  isOpen: boolean,
  onClose: () => void,
  dialogRef: RefObject<HTMLElement | null>,
) => {
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));

    const first = focusable()[0];
    (first ?? dialog).focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const elements = focusable();
      if (elements.length === 0) {
        event.preventDefault();
        return;
      }
      const firstElement = elements[0];
      const lastElement = elements[elements.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === firstElement || !dialog.contains(active))) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && (active === lastElement || !dialog.contains(active))) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [isOpen, onClose, dialogRef]);
};
