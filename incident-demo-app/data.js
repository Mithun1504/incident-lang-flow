// Fictional workspace data. Edits are kept in memory and reset on restart.
module.exports = {
  profile: { name: 'Maya Lawson', title: 'Product Operations Manager', email: 'maya.lawson@example.com', phone: '+1 (415) 555-0142', department: 'Operations', location: 'San Francisco, CA', timezone: 'America/Los_Angeles', joined: 'March 12, 2024', bio: 'Helping teams turn good ideas into thoughtful, reliable products.' },
  projects: [
    { id: 'PRJ-101', name: 'Customer portal redesign', description: 'A simpler experience for every customer.', owner: 'Maya Lawson', initials: 'ML', status: 'In progress', progress: 68, due: 'Dec 12, 2026', tasks: 24, completed: 16 },
    { id: 'PRJ-102', name: 'Q4 operations review', description: 'Align our processes for the year ahead.', owner: 'Daniel Kim', initials: 'DK', status: 'In review', progress: 92, due: 'Nov 28, 2026', tasks: 12, completed: 11 },
    { id: 'PRJ-103', name: 'Partner onboarding', description: 'Make the first thirty days count.', owner: 'Amelia Chen', initials: 'AC', status: 'In progress', progress: 45, due: 'Dec 18, 2026', tasks: 20, completed: 9 },
    { id: 'PRJ-104', name: 'Knowledge base refresh', description: 'Keep the answers clear and current.', owner: 'James Wilson', initials: 'JW', status: 'Planning', progress: 18, due: 'Jan 08, 2027', tasks: 16, completed: 3 },
    { id: 'PRJ-105', name: 'Support handoff playbook', description: 'Better context. Faster resolutions.', owner: 'Sofia Patel', initials: 'SP', status: 'Completed', progress: 100, due: 'Nov 15, 2026', tasks: 18, completed: 18 }
  ],
  team: [
    { name: 'Maya Lawson', initials: 'ML', email: 'maya.lawson@example.com', role: 'Product Operations Manager', department: 'Operations', location: 'San Francisco', status: 'Active' },
    { name: 'Daniel Kim', initials: 'DK', email: 'daniel.kim@example.com', role: 'Product Designer', department: 'Design', location: 'Seattle', status: 'Active' },
    { name: 'Amelia Chen', initials: 'AC', email: 'amelia.chen@example.com', role: 'Engineering Lead', department: 'Engineering', location: 'New York', status: 'Active' },
    { name: 'James Wilson', initials: 'JW', email: 'james.wilson@example.com', role: 'Content Strategist', department: 'Marketing', location: 'London', status: 'Away' },
    { name: 'Sofia Patel', initials: 'SP', email: 'sofia.patel@example.com', role: 'Customer Success Lead', department: 'Customer Success', location: 'Austin', status: 'Active' },
    { name: 'Oliver Grant', initials: 'OG', email: 'oliver.grant@example.com', role: 'Software Engineer', department: 'Engineering', location: 'Toronto', status: 'Active' }
  ],
  tasks: [
    { title: 'Review the customer portal wireframes', project: 'Customer portal redesign', due: 'Today', status: 'Priority' },
    { title: 'Share the operations review agenda', project: 'Q4 operations review', due: 'Tomorrow', status: 'Upcoming' },
    { title: 'Approve partner welcome materials', project: 'Partner onboarding', due: 'Nov 24', status: 'Upcoming' }
  ],
  activity: [
    { name: 'Daniel Kim', initials: 'DK', action: 'shared new design explorations', project: 'Customer portal redesign', time: '12 minutes ago' },
    { name: 'Amelia Chen', initials: 'AC', action: 'completed the onboarding checklist', project: 'Partner onboarding', time: '48 minutes ago' },
    { name: 'Sofia Patel', initials: 'SP', action: 'published the support handoff playbook', project: 'Support handoff playbook', time: '2 hours ago' }
  ],
  settings: { workspace: 'Northstar', timezone: 'America/Los_Angeles', weeklyDigest: true, projectUpdates: true, taskReminders: false }
};
