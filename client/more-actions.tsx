import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { ICONS } from "./icons";
import { IconButton, type Styles } from "./kit";

export interface RowAction {
  label: string;
  onPress(): void;
  danger?: boolean;
  disabled?: boolean;
}

// A row's secondary actions, one tap away: a quiet "more" button that shows them as a line of text
// buttons under the row. Paseo's kit has no menu component, and this works the same with mouse and touch.
export function useMoreActions(name: string, actions: readonly RowAction[], styles: Styles): { button: ReactNode; panel: ReactNode } {
  const [open, setOpen] = useState(false);
  const button = <IconButton icon={open ? ICONS.close : ICONS.more} label={open ? `Hide actions for ${name}` : `More actions for ${name}`} onPress={() => setOpen((value) => !value)} styles={styles} />;
  const panel = open ? (
    <View style={[styles.wrap, { justifyContent: "flex-end", gap: 14, paddingRight: 8, paddingBottom: 2 }]}>
      {actions.map((action) => (
        <Pressable
          key={action.label}
          disabled={action.disabled}
          accessibilityRole="button"
          accessibilityLabel={`${action.label} ${name}`}
          onPress={() => {
            setOpen(false);
            action.onPress();
          }}
        >
          <Text style={[action.danger ? styles.danger : styles.link, action.disabled ? { opacity: 0.4 } : null]}>{action.label}</Text>
        </Pressable>
      ))}
    </View>
  ) : null;
  return { button, panel };
}
