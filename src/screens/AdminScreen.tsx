import { useState } from 'react'
import { AdminShell } from '../components/AdminShell'
import { useFleet } from '../hooks/useFleet'
import { DriversPanel } from './admin/DriversPanel'
import { RoutesPanel } from './admin/RoutesPanel'
import { UsersPanel } from './admin/UsersPanel'

type Section = 'users' | 'drivers' | 'routes'
const SECTIONS: { key: Section; label: string }[] = [
  { key: 'users', label: 'Users' },
  { key: 'drivers', label: 'Drivers' },
  { key: 'routes', label: 'Routes' },
]

/** Admin-only panel for the tasks previously done via the Supabase dashboard,
 *  SQL, or seed scripts: Logins/roles (Users, via the admin Edge Function), the
 *  driver Roster, and Routes. One AdminShell section with an in-page segmented
 *  control so the portal's top nav stays a single row. */
export function AdminScreen() {
  const [section, setSection] = useState<Section>('users')
  const { fleet, reload } = useFleet()
  const drivers = fleet?.drivers ?? []
  const routes = fleet?.routes ?? []

  return (
    <AdminShell
      active="admin"
      title="Admin"
      meta="Access & fleet"
      actions={<Segmented section={section} onChange={setSection} />}
    >
      {section === 'users' && <UsersPanel drivers={drivers} reloadFleet={reload} />}
      {section === 'drivers' && <DriversPanel drivers={drivers} reload={reload} />}
      {section === 'routes' && <RoutesPanel routes={routes} drivers={drivers} reload={reload} />}
    </AdminShell>
  )
}

function Segmented({ section, onChange }: { section: Section; onChange: (s: Section) => void }) {
  return (
    <div className="flex rounded-[12px] border border-line bg-paper p-0.5">
      {SECTIONS.map((s) => {
        const on = s.key === section
        return (
          <button
            key={s.key}
            type="button"
            onClick={() => onChange(s.key)}
            aria-pressed={on}
            className={`rounded-[10px] px-3.5 py-1.5 font-serif text-[13px] uppercase tracking-[1px] transition ${
              on ? 'bg-white text-ink shadow-[0_1px_2px_rgba(13,19,32,.12)]' : 'text-muted hover:text-ink'
            }`}
          >
            {s.label}
          </button>
        )
      })}
    </div>
  )
}
