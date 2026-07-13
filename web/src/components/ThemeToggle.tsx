import { Moon, Sun } from 'lucide-react';
import { useUiStore } from '../stores/uiStore';
import './ThemeToggle.css';

export function ThemeToggle() {
  const theme = useUiStore((state) => state.theme);
  const dark = theme === 'dark';

  return (
    <button
      aria-label={dark ? '切换到浅色主题' : '切换到深色主题'}
      className="theme-toggle"
      onClick={() => useUiStore.getState().toggleTheme()}
      title={dark ? '切换到浅色主题' : '切换到深色主题'}
      type="button"
    >
      {dark ? <Moon size={16} /> : <Sun size={16} />}
    </button>
  );
}
