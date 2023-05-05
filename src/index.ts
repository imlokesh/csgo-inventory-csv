#!/usr/bin/env node

import { stringify } from "csv-stringify/sync";
import * as fs from "fs";
import NodeCache from "node-cache";
import axios from "axios";
import { Inventory, ParsedItem, PriceData } from "./types";
import winston from "winston";
import inquirer from "inquirer";
import { XMLParser } from "fast-xml-parser";
import { argv } from "process";

const verbose = argv.includes("--verbose");

const log = winston.createLogger({
  level: verbose ? "debug" : "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
    winston.format.printf((info) => `${info.timestamp} [${info.level}] - ${info.message}`)
  ),
  transports: [new winston.transports.Console()],
});

if (verbose) log.debug("Using verbose logging. ");

let ids: string[] = Array();
let selectedCurrency: string = "INR";

await inquirer
  .prompt([
    {
      type: "input",
      message: "Please enter steam user ids separated by comma: ",
      name: "ids",
      validate: (input) => parseIds(input).length > 0 || "Please a valid value. ",
    },
    {
      type: "input",
      message: "Please enter currency: ",
      name: "currency",
      default: "INR",
      validate: (input) => input?.length == 3 || "Please a valid value. ",
    },
  ])
  .then((answers) => {
    ids = parseIds(answers.ids);
    selectedCurrency = answers.currency.toUpperCase();
  });

log.debug(`Input ids are ${JSON.stringify(ids)}`);

let cache = new NodeCache();

axios.interceptors.request.use((req) => {
  if (req.transitional) {
    req.transitional.silentJSONParsing = false;
    req.transitional.forcedJSONParsing = false;
  }
  log.debug(`${req.method} ${req.url}`);
  return req;
});

for (const id of ids) {
  log.info(`Getting SteamId64 for ${id}. `);

  let url = `https://steamcommunity.com/id/${id}?xml=1`;

  let steamId64 = "";

  try {
    let res = await axios.get(url);
    steamId64 = new XMLParser().parse(res.data).profile.steamID64;
    if (steamId64 == undefined) throw new Error("Could not parse SteamID64");
  } catch (error) {
    console.error("Error getting SteamId64. ", error);
    continue;
  }

  let inventoryUrl = `https://steamcommunity.com/inventory/${steamId64}/730/2?l=english&count=200`;

  log.info(`Getting csgo inventory for ${steamId64}`);

  try {
    let res = await axios.get(inventoryUrl);
    let inventoryData = res.data;
    var inventoryItems: Inventory = JSON.parse(inventoryData);
  } catch (error) {
    console.error("Error getting inventory data. ", error);
    continue;
  }

  let parsedItems: ParsedItem[] = new Array();

  for (const asset of inventoryItems.assets) {
    let desc = inventoryItems.descriptions.find((d) => asset.classid == d.classid);

    if (desc == undefined) {
      log.error(`Could not find description for ${JSON.stringify(asset)}`);
      continue;
    }

    let itemId = desc.market_hash_name;
    let priceRes: string | undefined = cache.get(itemId);

    if (desc.marketable && priceRes != undefined) log.debug("CACHE HIT");

    if (desc.marketable && priceRes == undefined) {
      try {
        log.info(`Getting price info for ${desc.market_hash_name} from csgobackpack. `);
        const res = await axios.get("https://csgobackpack.net/api/GetItemPrice/", {
          params: { id: itemId, currency: selectedCurrency },
        });

        priceRes = res.data;
      } catch (error) {
        console.error("Error getting price data", error);
      }
    }

    let priceData: PriceData | null = null;

    try {
      priceData = JSON.parse(priceRes ?? "{}");
      cache.set(itemId, priceRes);
    } catch (error) {
      log.error(`Error parsing price data. Invalid json response. `);
      log.debug(priceRes);
    }

    parsedItems.push({
      Type: desc.type,
      MarketName: desc.market_name,
      MarketHashName: desc.market_hash_name,
      Marketable: desc.marketable == 1 ? "Yes" : "No",
      Exterior: desc.tags.find((t) => t.category == "Exterior")?.localized_tag_name || "",
      ItemSet: desc.tags.find((t) => t.category == "ItemSet")?.localized_tag_name || "",
      Quality: desc.tags.find((t) => t.category == "Quality")?.localized_tag_name || "",
      Rarity: desc.tags.find((t) => t.category == "Rarity")?.localized_tag_name || "",
      Weapon: desc.tags.find((t) => t.category == "Weapon")?.localized_tag_name || "",
      AveragePrice: priceData?.average_price || "",
      MedianPrice: priceData?.median_price || "",
      LowestPrice: priceData?.lowest_price || "",
      HighestPrice: priceData?.highest_price || "",
      Currency: priceData?.currency || "",
      StandardDeviation: priceData?.standard_deviation || "",
      Volume: priceData?.amount_sold || "",
    });
  }
  let filename = `${id}_${steamId64}_${Math.round(new Date().getTime() / 1000)}.csv`;
  log.info(`Saving data to ${filename}`);
  fs.writeFileSync(filename, stringify(parsedItems, { header: true }));
}

function parseIds(idstr: string) {
  if (!idstr) return [];
  return idstr
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}
