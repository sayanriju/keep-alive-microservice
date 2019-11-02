const Express = require("express")
const Redis = require("ioredis")
const bodyParser = require("body-parser")
const { addSeconds } = require("date-fns")

const http = require("http")
const Faye = require("faye")

require("dotenv").config()

const app = Express()
const redis = new Redis({
  port: process.env.REDIS_PORT, // Redis port
  host: process.env.REDIS_HOST, // Redis host
  family: 4, // 4 (IPv4) or 6 (IPv6)
  password: process.env.REDIS_PASS,
  db: 0
})

app.use(bodyParser.urlencoded({ extended: false }))
app.use(bodyParser.json())
app.use(Express.static(`${__dirname}/public`))
app.set("view engine", "ejs")

const server = http.createServer(app)

/** Lib Functions */
const isNewId = async (id) => await redis.zrank("online-until", `id:${id}`) === null
const upsertOnline = async (id, onlineUntilTimestamp) => redis.zadd("online-until", onlineUntilTimestamp, `id:${id}`)
const getOnlines = async () => {
  const ids = await redis.zrangebyscore("online-until", Date.now(), "+inf")
  return ids.map((id) => id.replace(/^id:/, ""))
}
const getOfflines = async () => {
  const ids = await redis.zrangebyscore("online-until", "-inf", Date.now())
  return ids.map((id) => id.replace(/^id:/, ""))
}
const purgeOfflines = async () => redis.zremrangebyscore("online-until", "-inf", Date.now())

/** Real time stuff */
const bayeux = new Faye.NodeAdapter({ mount: process.env.FAYE_MOUNT_PATH, timeout: process.env.FAYE_TIMEOUT })
bayeux.attach(server)


bayeux.getClient()
  .subscribe("/heartbeat/*")
  .withChannel(async (channel, data) => {
    try {
      const id = channel.split("/")[2]
      if (id) {
        if (await isNewId(id) === true) await bayeux.getClient().publish("/just-came-online", { id })
        const onlineUntilTimestamp = addSeconds(Date.now(), process.env.ALIVE_TIMEOUT).valueOf()
        await upsertOnline(id, onlineUntilTimestamp)
      }
    } catch (e) {
      console.log("==> ERR: ", e);
    }
  })

setInterval(async () => {
  const ids = await getOfflines()
  if (ids.length !== 0) bayeux.getClient().publish("/went-offline", { ids })
  await purgeOfflines()
}, process.env.CHECK_EVERY * 1000)

/** Non-realtime */

const checkAuthMiddleware = function (req, res, next) {
  if (!process.env.REQUIRE_AUTH) return next()
  try {
    const token = req.get("authorization").split(" ").pop()
    if (process.env.AUTH_TOKEN !== token) throw new Error("Invalid Auth Token!")
    return next()
  } catch (error) {
    return res.status(403).send(error.message)
  }
}

/**
 *
 * @api {get} /onlines Find all currently online id-s
 * @apiName FindOnlines
 *
 * @apiHeader {String} [Authorization] The Access Token in format "Token xxxxyyyyzzzz"
 */

app.get("/onlines", checkAuthMiddleware, async (req, res) => {
  const onlines = await getOnlines()
  console.log("Currently online id-s: ", onlines)
  await purgeOfflines()
  return res.json({ onlines })
})

/** Web routes for demo */
app.get("/demo/client", (req, res) => res.render("demo/index.ejs", { siteUrl: process.env.SITE_URL }))
app.get("/demo/status", async (req, res) => {
  const onlines = await getOnlines()
  console.log("Currently online id-s: ", onlines)
  await purgeOfflines()
  return res.render("demo/status.ejs", { siteUrl: process.env.SITE_URL, onlines })
})


server.listen(process.env.PORT || 8080, () => {
  console.log(`==> Example app listening on port ${process.env.PORT || 8080}`)
})
