const Cumulio = require('cumulio');
const sdk = require('@cumul.io/dashboard-sdk');
const moment = require('moment');
const { Configuration, OpenAIApi } = require('openai');
const levenshtein = require('fast-levenshtein');
const { json } = require('stream/consumers');

require('dotenv').config();

class IM {

  constructor() {
    if (process.env.CUMULIO_API_KEY?.length <= 0 || process.env.CUMULIO_API_SECRET?.length <= 0) {
      throw new Error("You must specify the `CUMULIO_API_KEY` and `CUMULIO_API_SECRET` environment variables for this script to work. You can create these in your Cumul.io profile: https://app.cumul.io/profile/api-tokens.");
    }

    this.cumulio = new Cumulio({
      host: process.env.CUMULIO_API_HOST_URL?.length > 0 ? process.env.CUMULIO_API_HOST_URL : null,
      api_key: process.env.CUMULIO_API_KEY,
      api_token: process.env.CUMULIO_API_SECRET
    });
    console.log("Using the following Cumul.io Environment: ", Cumulio.HOST);
    
    if (process.env.OPENAI_API_SECRET?.length <= 0) {
      throw new Error("You must specify the `OPENAI_API_SECRET` environment variables for this script to work, see OpenAI for more information. You can create a free OpenAI account here: https://platform.openai.com/.");
    }
    
    this.openai = new OpenAIApi(new Configuration({
      apiKey: process.env.OPENAI_API_SECRET,
    }));
        
    this.initialized = false;
    this.idsSeen = [];
    
    console.log('[AI] Listening for new Cumul.io datasets')
  }

  async run() {
    this.getNewDatasets().then(result => {
      if (!this.initialized) {
        this.idsSeen = result.rows.map(set => set.id);
        this.initialized = true;
        console.log('ids seen', this.idsSeen);
      }
      else {
        let datasets = result.rows;
        console.log('new sets', datasets.rows);
        this.idsSeen = this.idsSeen.concat(datasets.map(set => set.id));
        datasets.forEach(async(dataset) => {
          await this.composeDashboard(dataset);
        });
      }
    }).catch(error => {
      console.log("An error occurred while getting the new datasets: ", error);
    });
  }

  async composeDashboard(dataset) {
    console.log(new Date(), dataset.id, 'Composing new dashboard for set');
    const prompt = this.prompt(dataset);
    console.log(new Date(), dataset.id, 'Prompt\n' + prompt);

    // Dream up a list of charts & a title
    const completion = await this.openai.createCompletion({
      model: 'text-davinci-002',
      prompt: prompt,
      temperature: 0.7,
      max_tokens: 1024,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0
    });
    console.log(new Date(), dataset.id, 'OpenAI response', JSON.stringify(completion.data));
    const text = completion.data.choices[0].text;

    let json;
    // Try to parse as JSON
    try {
      json = JSON.parse(text);
    }
    catch (e) {
      return console.log(new Date(), dataset.id, 'Result was not valid JSON :-(');
    }

    console.log(new Date(), dataset.id, 'OpenAI response as JSON\n', JSON.stringify(json, null, 2));

    try {
      // Construct the dashboard
      let dashboard = new sdk.Dashboard();
      dashboard.setDescription(`This is a dashboard based on the set \'${dataset.name.en}\' that was autogenerated by Cumul.io Insight Mining (v1).`);
      dashboard.setName('(AI) ' + this.findTitle(json.dashboard_title));
      dashboard.setTheme('bliss');

      // Construct the charts
      let i = 0;
      for (const chart of json.charts) {
        dashboard.addItem(this.composeChart(dataset, chart, i++));
      }

      // Create the dashboard
      let cumulioDashboard = dashboard.toJSON();
      cumulioDashboard.contents.views.forEach(view => {
        view.options.showTitle = true;
      });
      await this.cumulio.create('securable', cumulioDashboard);
    }
    catch(e) {
      return console.log(new Date(), dataset.id, 'Encountered issue while composing dashboard using SDK', e);
    }
  }

  composeChart(dataset, chart, i) {
    const chartMatch = this.findBestChartMatch(chart.type);
    const metric = this.findColumn(dataset, chart.metric);
    const dimension = this.findColumn(dataset, chart.dimension);
    const aggregation = metric.columnId === '*' ? 'count' : chart.metric_aggregation;

    let sdkChart = new sdk[chartMatch.type]()
      .setTitle(this.findTitle(chart.title))
      .setSize({width: 24, height: 20})
      .setPosition({row: Math.floor(i / 2) * 20, col: (i % 2) * 24})
      .setData(chartMatch.measure, metric, {
        format: aggregation === 'count' ? '.0f' : '.2f',
        aggregation
      })
      .setData(chartMatch.dimension, dimension, {
        level: dimension.type === 'datetime' ? this.findBestLevel(chart.title) : undefined
      });

    if (chartMatch.options) {
      for (const option of chartMatch.options) {
        sdkChart = sdkChart.setOption(option.name, option.value);
      }
    }

    return sdkChart;
  }

  findTitle(title) {
    return title.replaceAll("\"", "");
  }

  findColumn(dataset, column_name) {
    let column = this.findBestColumnMatch(dataset, column_name);
    if (!column)
      return null;
    return new sdk.Column({
      datasetId: dataset.id,
      columnId: column.id,
      label: column.name,
      type: column.type
    });
  }

  findBestLevel(column_name) {
    if (column_name.toLowerCase().includes('year'))
      return 1;
    else if (column_name.toLowerCase().includes('quarter'))
      return 2;
    else if (column_name.toLowerCase().includes('month'))
      return 3;
    else if (column_name.toLowerCase().includes('week'))
      return 4;
    else if (column_name.toLowerCase().includes('hour'))
      return 6;
    else if (column_name.toLowerCase().includes('minute'))
      return 7;
    else if (column_name.toLowerCase().includes('second'))
      return 8;
    return 5;
  }

  findBestColumnMatch(dataset, column_name) {
    if (column_name === 'count')
      return {
        id: '*',
        name: {en: 'Count'},
        type: 'numeric'
      };
    if (dataset.columns.length === 0)
      return null;
    let columns = dataset.columns;
    columns.sort((a, b) => levenshtein.get(column_name, a.name.en) - levenshtein.get(column_name, b.name.en));
    return columns[0];
  }

  findBestChartMatch(chart_type) {
    if (chart_type.includes('stacked bar'))
      return {
        type: 'BarChart',
        measure: 'measure',
        dimension: 'y-axis',
        options: [
          {name: 'mode', value: 'stacked'}
        ]
      };
    else if (chart_type.includes('bar'))
      return {type: 'BarChart', measure: 'measure', dimension: 'y-axis'};
    else if (chart_type.includes('line'))
      return {type: 'LineChart', measure: 'measure', dimension: 'x-axis'};
    else if (chart_type.includes('pie') || chart_type.includes('donut'))
      return {type: 'Donut', measure: 'measure', dimension: 'category'};
    else if (chart_type.includes('area'))
      return {type: 'AreaChart', measure: 'measure', dimension: 'x-axis'};
    else if (chart_type.includes('scatter'))
      return {type: 'BarChart', measure: 'measure', dimension: 'y-axis'};
    else if (chart_type.includes('column'))
      return {type: 'ColumnChart', measure: 'measure', dimension: 'category'};

    console.error(new Date(), `Encountered unknown chart type '${chart_type}', substituting BarChart`)
    return {type: 'BarChart', measure: 'measure', dimension: 'y-axis'};
  }

  prompt(dataset) {
    return `"### Given PostgreSQL schema:\n#\n# ${dataset.name.en} (${dataset.columns.map(col => col.name.en).join(', ')})\n#\n# Make a list of the 6 most relevant charts to visualize, as JSON:\n#\n# {\n#   \"dashboard_title\": \"Dashboard title\",\n#   \"charts\": [\n#     {\n#       \"title\": \"Chart title\",\n#       \"type\": \"chart_type\",\n#       \"metric\": \"metric\",\n#       \"metric_aggregation\": \"aggregation\",\n#       \"dimension\": \"dimension\"\n#    }\n# }\n\n`;
  }

  async getNewDatasets() {
    if (!this.initialized)
      console.log('Initializing with existing sets');
    else
      console.log('Checking for new sets');

    return await this.cumulio.get('securable', {
      attributes: ['id', 'name'],
      where: {
        type: 'dataset',
        id: {notIn: this.idsSeen ?? []}
      },
      include: [{
        model: 'Column',
        attributes: ['id', 'type', 'name', 'stats'],
      }]
    });
  }

}

const im = new IM();

// Poll every 5 seconds
setInterval(() => {
  im.run();
}, 5000);
