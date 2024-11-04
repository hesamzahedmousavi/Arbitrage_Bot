import dotenv from "dotenv";
import axios from "axios";
import { ethers } from "ethers";
import fs from "fs";
import Moralis from "moralis";
import path from "path";
import chalk from "chalk";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";
dotenv.config();
let openTrades = {};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { RPC_URL, PRIVATE_KEY, MORALIS_API_KEY, EMAIL_USER, EMAIL_PASS } =
  process.env;
const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const TRADES_FILE_PATH = path.join(__dirname, "trades.json");
const sendEmailReport = async () => {
  try {
    const tradesData = fs.readFileSync(TRADES_FILE_PATH, "utf-8");
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: EMAIL_USER,
        pass: EMAIL_PASS,
      },
    });

    const mailOptions = {
      from: EMAIL_USER,
      to: EMAIL_USER,
      subject: "Daily Trades Report",
      text: `Here is your daily trades report:\n\n${tradesData}`,
    };

    await transporter.sendMail(mailOptions);
    console.log("Daily trades report sent successfully.");
  } catch (error) {
    console.error("Error sending daily report email:", error.message);
  }
};

const scheduleDailyEmail = () => {
  sendEmailReport();
  setInterval(sendEmailReport, 24 * 60 * 60 * 1000);
};

const WETH_ADDRESS = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";
const SUSHISWAP_ROUTER_ADDRESS = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";
const UNISWAP_ROUTER_ADDRESS = "0x7a250d5630b4cf539739df2c5dacabbe0a1c317c";
const ROUTER_ABI = [
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
];

const sushiswapRouter = new ethers.Contract(
  SUSHISWAP_ROUTER_ADDRESS,
  ROUTER_ABI,
  wallet
);
const uniswapRouter = new ethers.Contract(
  UNISWAP_ROUTER_ADDRESS,
  ROUTER_ABI,
  wallet
);

const CHECK_INTERVAL = 10 * 60 * 1000;

const readTokensFromFile = () => {
  try {
    console.log("Reading tokens from data.json...");
    const data = fs.readFileSync("data.json", "utf-8");
    const tokens = JSON.parse(data).data || [];
    console.log("Tokens read successfully:", tokens);
    return tokens;
  } catch (error) {
    console.error("Error reading tokens from file:", error.message);
    return [];
  }
};

const getWethUsdPrice = async () => {
  try {
    console.log("Fetching WETH to USD price...");
    const response = await Moralis.EvmApi.token.getTokenPrice({
      chain: "0x89",
      address: WETH_ADDRESS,
    });
    const wethUsdPrice = response.toJSON()?.usdPrice || null;
    console.log("WETH to USD price fetched:", wethUsdPrice);
    return wethUsdPrice;
  } catch (error) {
    console.error("Error fetching WETH to USD price:", error.message);
    return null;
  }
};

export const getTokenPrice = async (tokenAddress, exchange) => {
  console.log(`Fetching ${exchange} price for token ${tokenAddress}...`);
  try {
    if (exchange === "uniswap") {
      const response = await Moralis.EvmApi.token.getTokenPrice({
        chain: "0x89",
        exchange: "uniswapv3",
        address: tokenAddress,
      });
      const price = response.toJSON()?.usdPrice || null;
      console.log(`Uniswap price for ${tokenAddress}:`, price);
      return price;
    } else if (exchange === "sushiswap") {
      const query = `
        {
          pairs(where: { token0: "${WETH_ADDRESS.toLowerCase()}", token1: "${tokenAddress.toLowerCase()}" }) {
            token0Price
          }
        }
      `;
      const response = await axios.post(
        "https://gateway.thegraph.com/api/6268f34c0eaa7b3e1aa36cb5418013fb/subgraphs/id/8obLTNcEuGMieUt6jmrDaQUhWyj2pys26ULeP3gFiGNv",
        { query }
      );
      const pairData = response.data.data.pairs[0];
      const wethUsdPrice = await getWethUsdPrice();
      const price = wethUsdPrice
        ? parseFloat(pairData.token0Price) * wethUsdPrice
        : null;
      console.log(`SushiSwap price for ${tokenAddress}:`, price);
      return price;
    }
  } catch (error) {
    console.error(
      `Error fetching ${exchange} price for ${tokenAddress}:`,
      error.message
    );
    return null;
  }
};

export const getTokenPrices = async (tokens) => {
  console.log("Fetching prices for all tokens...");
  const prices = await Promise.all(
    tokens.map(async ({ symbol, token }) => {
      console.log(`Fetching prices for ${symbol}...`);
      const [sushiswap, uniswap] = await Promise.all([
        getTokenPrice(token, "sushiswap"),
        getTokenPrice(token, "uniswap"),
      ]);
      console.log(
        `Prices for ${symbol}: SushiSwap: ${sushiswap}, Uniswap: ${uniswap}`
      );
      return { symbol, prices: { sushiswap, uniswap } };
    })
  );
  console.log("All token prices fetched:", prices);
  return Object.fromEntries(
    prices.map(({ symbol, prices }) => [symbol, prices])
  );
};

const findArbitrageOpportunities = (prices) => {
  console.log("Analyzing arbitrage opportunities...");
  const transactionCostPercentage = 1;
  const minimumNetProfit = 3;

  const opportunities = Object.entries(prices)
    .map(([symbol, { sushiswap, uniswap }]) => {
      if (sushiswap && uniswap) {
        const arbitragePercentage =
          (Math.abs(sushiswap - uniswap) / ((sushiswap + uniswap) / 2)) * 100;
        const netArbitrage = (
          arbitragePercentage - transactionCostPercentage
        ).toFixed(2);
        console.log(`Arbitrage for ${symbol}:`, {
          sushiswap,
          uniswap,
          netArbitrage,
        });

        return netArbitrage > minimumNetProfit
          ? { symbol, sushiswap, uniswap, netArbitrage }
          : null;
      }
      return null;
    })
    .filter(Boolean);

  console.log("Arbitrage opportunities found:", opportunities);
  return opportunities;
};

const readTradesFromFile = () => {
  try {
    if (!fs.existsSync(TRADES_FILE_PATH)) {
      fs.writeFileSync(TRADES_FILE_PATH, JSON.stringify([]));
    }
    const data = fs.readFileSync(TRADES_FILE_PATH, "utf-8");
    return JSON.parse(data);
  } catch (error) {
    console.error("Error reading trades from file:", error.message);
    return [];
  }
};

const writeTradesToFile = (trades) => {
  try {
    fs.writeFileSync(TRADES_FILE_PATH, JSON.stringify(trades, null, 2));
    console.log("Trades written to file successfully.");
  } catch (error) {
    console.error("Error writing trades to file:", error.message);
  }
};

const logTrade = (trade) => {
  const trades = readTradesFromFile();
  trades.push(trade);
  writeTradesToFile(trades);
};

const executeTrade = async (exchange, tokenAddress, amount, isOpen) => {
  try {
    const balance = await provider.getBalance(wallet.address);
    const amountToTrade = ethers.utils.formatEther(balance);

    console.log(
      `Preparing to ${
        isOpen ? "open" : "close"
      } trade on ${exchange} for token ${tokenAddress} with total wallet balance amount ${amountToTrade}...`
    );

    const router = exchange === "SushiSwap" ? sushiswapRouter : uniswapRouter;
    const path = isOpen
      ? [tokenAddress, WETH_ADDRESS]
      : [WETH_ADDRESS, tokenAddress];

    const txOptions = {
      gasLimit: 8000000,
      gasPrice: ethers.utils.parseUnits("60", "gwei"),
    };

    const tx = await router.swapExactTokensForTokens(
      ethers.utils.parseUnits(amountToTrade.toString(), 18),
      0,
      path,
      wallet.address,
      Math.floor(Date.now() / 1000) + 60 * 20,
      txOptions
    );

    console.log("Transaction hash:", tx.hash);
    console.log("Waiting for transaction confirmation...");

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Transaction confirmation timed out")),
        1800000
      )
    );

    const receipt = await Promise.race([tx.wait(3), timeoutPromise]);

    if (receipt) {
      console.log(
        `Transaction confirmed with ${receipt.confirmations} confirmations.`
      );

      if (isOpen) {
        const buyPrice = await getTokenPrice(tokenAddress, "uniswap");
        openTrades[tokenAddress] = {
          buyPrice: buyPrice * amountToTrade,
          buyHash: tx.hash,
          buyBlock: receipt.blockNumber,
          openTime: Date.now(),
        };
      } else {
        const openTrade = openTrades[tokenAddress];
        if (openTrade) {
          const sellPrice = await getTokenPrice(tokenAddress, "sushiswap");
          const profitOrLoss = sellPrice * amountToTrade - openTrade.buyPrice;
          const profitOrLossPercentage = (
            (profitOrLoss / openTrade.buyPrice) *
            100
          ).toFixed(2);

          const tradeLog = {
            tokenAddress,
            exchange,
            buyHash: openTrade.buyHash,
            sellHash: tx.hash,
            buyPrice: openTrade.buyPrice,
            sellPrice: sellPrice * amountToTrade,
            profitOrLoss,
            profitOrLossPercentage,
            openTime: new Date(openTrade.openTime).toISOString(),
            closeTime: new Date().toISOString(),
          };

          if (profitOrLoss > 0) {
            console.log(
              chalk.green(
                `Trade closed for ${tokenAddress} with profit of ${profitOrLoss} (${profitOrLossPercentage}%)`
              )
            );
          } else {
            console.log(
              chalk.red(
                `Trade closed for ${tokenAddress} with loss of ${profitOrLoss} (${profitOrLossPercentage}%)`
              )
            );
          }

          logTrade(tradeLog);

          delete openTrades[tokenAddress];
        } else {
          console.log(
            `No open trade found for ${tokenAddress} to calculate profit or loss.`
          );
        }
      }
    } else {
      console.log("Transaction timed out or failed to confirm.");
    }

    return receipt;
  } catch (error) {
    console.error(
      `Error ${isOpen ? "opening" : "closing"} trade for ${tokenAddress}:`,
      error.message
    );
    return null;
  }
};

const initializeBot = async () => {
  try {
    console.log("Initializing Moralis...");
    await Moralis.start({ apiKey: MORALIS_API_KEY });
    console.log("Moralis initialized.");
  } catch (error) {
    console.error("Failed to initialize Moralis:", error.message);
    process.exit(1);
  }
};

const main = async () => {
  try {
    console.log("Starting arbitrage bot...");

    const tokens = readTokensFromFile();
    if (!tokens.length) {
      console.log("No tokens found. Please check your tokens file.");
      return;
    }

    console.log("Fetching token prices...");
    const prices = await getTokenPrices(tokens);
    console.log("Token prices fetched successfully.");

    const opportunities = findArbitrageOpportunities(prices);
    if (!opportunities.length) {
      console.log("No arbitrage opportunities found above 1% net profit.");
      return;
    }

    for (const opportunity of opportunities) {
      console.log(
        `Arbitrage opportunity found for ${opportunity.symbol}: ${opportunity.netArbitrage}%`
      );
      const tokenAddress = tokens.find(
        (t) => t.symbol === opportunity.symbol
      ).token;
      const { sushiswap, uniswap } = opportunity;
      const lowerExchange = sushiswap < uniswap ? "SushiSwap" : "Uniswap";
      const higherExchange =
        lowerExchange === "SushiSwap" ? "Uniswap" : "SushiSwap";
      const lowerPrice = Math.min(sushiswap, uniswap);

      console.log(
        `Attempting to open trade on ${lowerExchange} for token ${tokenAddress}...`
      );
      const buyReceipt = await executeTrade(
        lowerExchange,
        tokenAddress,
        lowerPrice,
        true
      );

      if (!buyReceipt || !openTrades[tokenAddress]) {
        console.log(
          `Failed to open trade for ${opportunity.symbol}. Skipping...`
        );
        continue;
      }

      console.log(
        `Trade opened successfully for ${opportunity.symbol} with transaction hash: ${buyReceipt.hash}`
      );

      const openTime = Date.now();
      let tradeClosed = false;

      while (!tradeClosed) {
        const currentTime = Date.now();
        const elapsed = (currentTime - openTime) / 1000 / 60;

        if (elapsed > 60) {
          console.log(`Closing trade for ${opportunity.symbol} after 1 hours.`);
          await executeTrade(higherExchange, tokenAddress, lowerPrice, false);
          console.log(`Trade closed after timeout for ${opportunity.symbol}.`);
          tradeClosed = true;
        } else {
          console.log(`Checking profit condition for ${opportunity.symbol}...`);
          const newPrice = await getTokenPrice(tokenAddress, higherExchange);
          const openTrade = openTrades[tokenAddress];

          if (openTrade) {
            const profitPercent =
              ((newPrice - openTrade.buyPrice) / openTrade.buyPrice) * 100;

            console.log(
              `Current profit for ${
                opportunity.symbol
              }: ${profitPercent.toFixed(2)}%`
            );
            if (profitPercent >= 3) {
              console.log(
                `Closing trade for ${opportunity.symbol} at 3% profit.`
              );
              await executeTrade(
                higherExchange,
                tokenAddress,
                lowerPrice,
                false
              );
              console.log(
                `Trade closed with profit for ${opportunity.symbol}.`
              );
              tradeClosed = true;
            }
          } else {
            console.log(
              `Open trade not found for ${opportunity.symbol}. Skipping profit check.`
            );
          }

          console.log(
            `Waiting ${
              CHECK_INTERVAL / 1000 / 60
            } minutes before next profit check.`
          );
          await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL));
        }
      }
    }
  } catch (error) {
    console.error("Error in main function:", error.message);
  }

  console.log("Cycle complete. Restarting main function...");
  setTimeout(main, 10000);
};

initializeBot()
  .then(() => {
    main();
  })
  .catch((error) => {
    console.error("Bot initialization failed:", error.message);
  });
