import { Loading, Markdown, Modal } from "@getpaseo/plugin/client/ui";
import { type ReactNode, useState } from "react";
import { Text, View } from "react-native";
import { ICONS } from "../icons";
import type { Styles } from "../kit";
import { Button, CopyButton, IconButton } from "./controls";
import { ListRow } from "./list";
import { emptyActions } from "./rules";

export interface SheetAction {
  label: string;
  onPress(): void;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
}

// A menu of actions in the host's Modal: a bottom sheet on phones, a dialog on desktop. Picking a
// row closes the sheet first, so an action that opens its own sheet never stacks on this one.
export function ActionSheet({ title, open, onOpenChange, actions, styles }: { title: string; open: boolean; onOpenChange(open: boolean): void; actions: readonly SheetAction[]; styles: Styles }) {
  return (
    <Modal title={title} open={open} onOpenChange={onOpenChange}>
      <Modal.Content contentContainerStyle={{ padding: 12, gap: 2 }}>
        {actions.map((action) => (
          <ListRow
            key={action.label}
            title={action.label}
            icon={action.icon}
            danger={action.danger}
            disabled={action.disabled}
            accessibilityLabel={`${action.label} ${title}`}
            onPress={() => {
              onOpenChange(false);
              action.onPress();
            }}
            styles={styles}
          />
        ))}
      </Modal.Content>
    </Modal>
  );
}

// A row's secondary actions behind one "more" button.
export function useActionSheet(name: string, actions: readonly SheetAction[], styles: Styles): { button: ReactNode; sheet: ReactNode } {
  const [open, setOpen] = useState(false);
  const button = <IconButton icon={ICONS.more} label={`More actions for ${name}`} onPress={() => setOpen(true)} disabled={actions.length === 0} styles={styles} />;
  const sheet = <ActionSheet title={name} open={open} onOpenChange={setOpen} actions={actions} styles={styles} />;
  return { button, sheet };
}

export type ViewState = { state: "loading" } | { state: "empty"; text: string; actions?: readonly { label: string; icon?: string; onPress(): void }[] } | { state: "error"; text: string };

export function StateView({ styles, ...view }: ViewState & { styles: Styles }) {
  if (view.state === "loading") return <Loading />;
  if (view.state === "error")
    return (
      <View style={{ borderWidth: 1, borderColor: styles.colors.border, borderRadius: 8, padding: 12 }} accessibilityRole="alert">
        <Text style={styles.danger}>{view.text}</Text>
      </View>
    );
  const actions = emptyActions(view.actions);
  return (
    <View style={{ alignItems: "center", gap: 24, paddingVertical: 24 }}>
      <Text style={[styles.muted, { textAlign: "center" }]}>{view.text}</Text>
      {actions.length > 0 ? (
        <View style={styles.row}>
          {actions.map((action) => (
            <Button key={action.label} label={action.label} icon={action.icon} onPress={action.onPress} styles={styles} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

export interface ReaderSheetProps {
  title: string;
  // Absent while the text is still being built.
  text?: string;
  meta?: string;
  error?: string;
  // Text an agent wrote is shown as plain text; Markdown is for documents people wrote.
  plain?: boolean;
  onOpen?(): void;
  pin?: { pinned: boolean; onChange(pinned: boolean): void };
  // Shown under the text, as a code entry's connections.
  footer?: ReactNode;
  onClose(): void;
  styles: Styles;
}

// Reads one stored text in the host's Modal, with Copy and the optional Open and Pin beside it.
export function ReaderSheet({ title, text, meta, error, plain = false, onOpen, pin, footer, onClose, styles }: ReaderSheetProps) {
  return (
    <Modal title={title} open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content>
        {error ? <StateView state="error" text={error} styles={styles} /> : text === undefined ? <StateView state="loading" styles={styles} /> : (
          <View style={{ gap: 12 }}>
            <View style={styles.compact ? { gap: 4 } : styles.row}>
              {meta ? <Text style={[styles.sm, styles.compact ? null : styles.grow]}>{meta}</Text> : <View style={styles.grow} />}
              <View style={styles.row}>
                <CopyButton text={text} styles={styles} />
                {onOpen ? <Button label="Open" icon={ICONS.open} onPress={onOpen} styles={styles} /> : null}
                {pin ? <Button label={pin.pinned ? "Unpin" : "Pin"} icon={pin.pinned ? ICONS.unpin : ICONS.pin} onPress={() => pin.onChange(!pin.pinned)} styles={styles} /> : null}
              </View>
            </View>
            {plain ? (
              <Text style={styles.text} selectable>
                {text}
              </Text>
            ) : (
              <Markdown>{text}</Markdown>
            )}
            {footer}
          </View>
        )}
      </Modal.Content>
    </Modal>
  );
}
