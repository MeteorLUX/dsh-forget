// Browser half of dsh-forget: adds a "Delete" row to each Session's "..."
// menu in the sidebar. It runs the host /forget command through the commands
// Remote (the documented "UI action calls a session command" pattern), then
// refreshes the session list so the row disappears.
window.__ModuleLoader__.load({
  id: 'dsh-forget',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const NS = 'forget';

    // Minimal menuitem styling using host theme tokens; `borderTop` groups the
    // destructive action after the shipped Archive row.
    const BUTTON_STYLE = {
      display: 'block',
      width: '100%',
      boxSizing: 'border-box',
      border: '0',
      borderTop: '1px solid var(--dsw-alias-border-l1)',
      background: 'transparent',
      color: 'var(--dsw-alias-state-error-primary)',
      textAlign: 'left',
      padding: '7px 14px',
      fontSize: '13px',
      lineHeight: '20px',
      cursor: 'pointer',
    };

    // The current (main-view) session: the only guaranteed-live agent the
    // commands Remote can run against. A session is "current" when the main
    // view retains it (retainedBy.mainView > 0).
    function currentSessionId(ctx) {
      try {
        const snapshot = ctx.sessions.list.getSnapshot();
        for (const id of snapshot.ids) {
          const row = snapshot.byId[id];
          if (row && row.retainedBy && (row.retainedBy.mainView ?? 0) > 0) return id;
        }
      } catch (error) {
        console.error('[dsh-forget] failed to read current session:', error);
      }
      return undefined;
    }

    function DeleteMenuItem({ sessionId, displayTitle, useMenuOpenState, t, deleteSession }) {
      const [, setMenuOpen] = useMenuOpenState();
      const [armed, setArmed] = React.useState(false);
      return h('button', {
        type: 'button',
        role: 'menuitem',
        style: BUTTON_STYLE,
        title: displayTitle || sessionId,
        onClick: () => {
          if (!armed) { setArmed(true); return; }
          setMenuOpen(false);
          void deleteSession(sessionId);
        },
        onMouseLeave: () => setArmed(false),
        onBlur: () => setArmed(false),
      }, armed ? t('confirm') : t('delete'));
    }

    return {
      inject: ['slots', 'locale', 'sessions', 'remote', 'remote.commands'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, {
          en: {
            delete: 'Delete',
            confirm: 'Confirm delete?',
          },
          zh: {
            delete: '删除',
            confirm: '确认删除？',
          },
        }), 'dsh-forget: dictionaries');

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'dsh-forget.delete',
          order: 500,
          locale: NS,
          inject: () => ({
            deleteSession: async (targetId) => {
              const current = currentSessionId(ctx);
              if (current === undefined) {
                console.error('[dsh-forget] no current session available to run the delete command from');
                return;
              }
              try {
                await ctx.remote.commands.execute(current, '/forget ' + targetId, []);
                await ctx.sessions.refresh();
              } catch (error) {
                console.error('[dsh-forget] delete failed:', error);
              }
            },
          }),
        }, DeleteMenuItem));
      },
    };
  },
});
