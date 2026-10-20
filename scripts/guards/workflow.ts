// How the guard tests read a GitHub Actions workflow without a YAML parser: its jobs, each job's
// runs-on, and each step as text. It reads only the shape this repo's workflows are written in
// (two-space indents: job ids at two, a job's keys at four, its steps at six), so a test that uses
// it first checks it found the jobs and steps it expects, and a reformatted file fails the test
// rather than passing unread.

// One job: its id, its runner, and its steps, each as its own lines with the indent and the
// step's leading "- " taken off (so `run: npm test`, or `uses: …` then `with:` and its keys), and
// comment and blank lines left out.
export interface WorkflowJob {
  id: string
  runsOn: string | undefined
  steps: string[]
}

const withoutComment = (value: string) => value.replace(/\s+#.*$/, '').trim()

export function workflowJobs(text: string): WorkflowJob[] {
  const lines = text.split('\n')
  const start = lines.findIndex(line => /^jobs:\s*(?:#.*)?$/.test(line))
  if (start === -1) return []
  const jobs: WorkflowJob[] = []
  let job: WorkflowJob | undefined
  let inSteps = false
  let step: string[] | undefined
  const endStep = () => {
    if (job && step) job.steps.push(step.join('\n'))
    step = undefined
  }
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue
    // Another top-level key ends the jobs.
    if (/^\S/.test(line)) break
    const header = /^ {2}([\w-]+):\s*(?:#.*)?$/.exec(line)
    if (header) {
      endStep()
      job = { id: header[1] ?? '', runsOn: undefined, steps: [] }
      jobs.push(job)
      inSteps = false
      continue
    }
    if (job === undefined) continue
    const key = /^ {4}([\w-]+):\s*(.*)$/.exec(line)
    if (key) {
      endStep()
      inSteps = key[1] === 'steps'
      if (key[1] === 'runs-on') job.runsOn = withoutComment(key[2] ?? '')
      continue
    }
    if (!inSteps) continue
    if (/^ {6}- /.test(line)) {
      endStep()
      step = [line.slice(8).trim()]
    } else if (step && /^ {8}/.test(line)) {
      step.push(line.trim())
    }
  }
  endStep()
  return jobs
}
