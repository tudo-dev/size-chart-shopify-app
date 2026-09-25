/**
 * Picks up size-chart work a restart interrupted, and checks the live charts
 * once a day (server/utils/size-chart-resume.ts).
 *
 * The first run waits a little, so the app is fully up, closes the job rows
 * a dead process left "running", then picks up what is owed. After that it
 * looks every hour whether the daily check is due; the time of the last
 * check is kept in the database, so a deploy does not reset the clock.
 */
import { clientForShop } from '../utils/shop-tokens'
import { closeJobsLeftByRestart } from '../utils/size-chart-jobs'
import { recheckDue, resumeSizeChartWork } from '../utils/size-chart-resume'

const FIRST_RUN_MS = 30_000
const EVERY_HOUR_MS = 60 * 60 * 1000

export default defineNitroPlugin(() => {
  const run = (startUp: boolean) => {
    try {
      if (startUp) {
        const closed = closeJobsLeftByRestart()
        if (closed > 0) console.log(`[Size charts] closed ${closed} job(s) the last restart left running`)
      }
      const recheck = recheckDue()
      const done = resumeSizeChartWork({ clientFor: clientForShop, allowedShops: process.env.ALLOWED_SHOPS, isDev: import.meta.dev }, { recheck, fetchPictures: startUp })
      if (done.withdraws > 0 || done.pictures > 0 || done.publish) {
        console.log(`[Size charts] picked up: ${done.withdraws} take-off(s) to finish, ${done.pictures} picture(s) to fetch, ${done.publish ? (recheck ? 'a check of the website' : 'approved charts to send') : 'nothing to send'}`)
      }
    }
    catch (error) {
      console.error('[Size charts] could not pick up the waiting work:', error)
    }
  }
  const first = setTimeout(() => run(true), FIRST_RUN_MS)
  const hourly = setInterval(() => run(false), EVERY_HOUR_MS)
  first.unref?.()
  hourly.unref?.()
})
