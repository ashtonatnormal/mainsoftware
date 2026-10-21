// The person's menu (T21; OD-05, X10): the avatar in a 44 px button named "Account, {name}", which
// opens the kit's Menu over the AVATAR_MENU registry. The name shows again at the top of the popup
// as decoration (the button's name already says it). On a phone it sits beside the screen's h1 and
// opens downward from the right; on the rail it sits in the rail's foot and opens upward over the
// screen, and the rail is laid out so nothing clips it (the Menu contract, ui/Menu.tsx).
import { useSession } from '@/api/queries.ts'
import { useRuntime } from '@/app/runtime-context.ts'
import { SHELL } from '@/strings/shell.ts'
import { Avatar } from '@/ui/Avatar.tsx'
import { IconButton } from '@/ui/Button.tsx'
import { Menu, type MenuItem } from '@/ui/Menu.tsx'
import { AVATAR_MENU } from './avatar-menu.ts'

export interface AvatarMenuProps {
  placement: 'bottom-end' | 'top-start'
}

export function AvatarMenu({ placement }: AvatarMenuProps) {
  const runtime = useRuntime()
  const person = useSession()
  const items: MenuItem[] = AVATAR_MENU.map(item => ({
    id: item.id,
    label: item.label,
    icon: item.icon,
    onSelect: () => void item.run(runtime),
  }))
  return (
    <Menu
      label={SHELL.account.menu}
      heading={person.name}
      items={items}
      placement={placement}
      trigger={props => (
        <IconButton
          {...props}
          label={SHELL.account.trigger(person.name)}
          icon={<Avatar personId={person.personId} name={person.name} size="sm" decorative />}
        />
      )}
    />
  )
}
